'use strict';

/**
 * Constants for token types
 */
const tokenTypes = {
  WHITESPACE: 'whitespace',
  WORD: 'word',
  STRING: 'string',
  RESERVED: 'reserved',
  RESERVED_TOP_LEVEL: 'reserved-top-level',
  RESERVED_TOP_LEVEL_NO_INDENT: 'reserved-top-level-no-indent',
  RESERVED_NEWLINE: 'reserved-newline',
  OPERATOR: 'operator',
  OPEN_PAREN: 'open-paren',
  CLOSE_PAREN: 'close-paren',
  LINE_COMMENT: 'line-comment',
  BLOCK_COMMENT: 'block-comment',
  NUMBER: 'number',
  PLACEHOLDER: 'placeholder'
};

const INDENT_TYPE_TOP_LEVEL = 'top-level';
const INDENT_TYPE_BLOCK_LEVEL = 'block-level';

/**
 * Manages indentation levels.
 *
 * There are two types of indentation levels:
 *
 * - BLOCK_LEVEL : increased by open-parenthesis
 * - TOP_LEVEL : increased by RESERVED_TOP_LEVEL words
 */
class Indentation {
  /**
   * @param {String} indent Indent value, default is "  " (2 spaces)
   */
  constructor(indent) {
    this.indent = indent || '  ';
    this.indentTypes = [];
  }

  /**
   * Returns current indentation string.
   * @return {String}
   */
  getIndent() {
    return this.indent.repeat(this.indentTypes.length);
  }

  /**
   * Increases indentation by one top-level indent.
   */
  increaseTopLevel() {
    this.indentTypes.push(INDENT_TYPE_TOP_LEVEL);
  }

  /**
   * Increases indentation by one block-level indent.
   */
  increaseBlockLevel() {
    this.indentTypes.push(INDENT_TYPE_BLOCK_LEVEL);
  }

  /**
   * Decreases indentation by one top-level indent.
   * Does nothing when the previous indent is not top-level.
   */
  decreaseTopLevel() {
    if (this.indentTypes.at(-1) === INDENT_TYPE_TOP_LEVEL) {
      this.indentTypes.pop();
    }
  }

  /**
   * Decreases indentation by one block-level indent.
   * If there are top-level indents within the block-level indent,
   * throws away these as well.
   */
  decreaseBlockLevel() {
    while (this.indentTypes.length > 0) {
      const type = this.indentTypes.pop();
      if (type !== INDENT_TYPE_TOP_LEVEL) {
        break;
      }
    }
  }

  resetIndentation() {
    this.indentTypes = [];
  }
}

const INLINE_MAX_LENGTH = 50;

/**
 * Bookkeeper for inline blocks.
 *
 * Inline blocks are parenthesized expressions that are shorter than INLINE_MAX_LENGTH.
 * These blocks are formatted on a single line, unlike longer parenthesized
 * expressions where open-parenthesis causes newline and increase of indentation.
 */
class InlineBlock {
  constructor() {
    this.level = 0;
  }

  /**
   * Begins inline block when lookahead through upcoming tokens determines
   * that the block would be smaller than INLINE_MAX_LENGTH.
   * @param  {Object[]} tokens Array of all tokens
   * @param  {Number} index Current token position
   */
  beginIfPossible(tokens, index) {
    if (this.level === 0 && this.isInlineBlock(tokens, index)) {
      this.level = 1;
    } else if (this.level > 0) {
      this.level++;
    } else {
      this.level = 0;
    }
  }

  /**
   * Finishes current inline block.
   * There might be several nested ones.
   */
  end() {
    this.level--;
  }

  /**
   * True when inside an inline block
   * @return {Boolean}
   */
  isActive() {
    return this.level > 0;
  }

  // Check if this should be an inline parentheses block
  // Examples are "NOW()", "COUNT(*)", "int(10)", key(`some_column`), DECIMAL(7,2)
  isInlineBlock(tokens, index) {
    let length = 0;
    let level = 0;

    for (let i = index; i < tokens.length; i++) {
      const token = tokens[i];
      length += token.value.length;

      // Overran max length
      if (length > INLINE_MAX_LENGTH) {
        return false;
      }

      if (token.type === tokenTypes.OPEN_PAREN) {
        level++;
      } else if (token.type === tokenTypes.CLOSE_PAREN) {
        level--;
        if (level === 0) {
          return true;
        }
      }

      if (this.isForbiddenToken(token)) {
        return false;
      }
    }
    return false;
  }

  // Reserved words that cause newlines, comments and semicolons
  // are not allowed inside inline parentheses block
  isForbiddenToken({ type, value }) {
    return (
      type === tokenTypes.RESERVED_TOP_LEVEL ||
      type === tokenTypes.RESERVED_NEWLINE ||
      type === tokenTypes.COMMENT ||
      type === tokenTypes.BLOCK_COMMENT ||
      value === ';'
    );
  }
}

/**
 * Handles placeholder replacement with given params.
 */
class Params {
  /**
   * @param {Object} params
   */
  constructor(params) {
    this.params = params;
    this.index = 0;
  }

  /**
   * Returns param value that matches given placeholder with param key.
   * @param {Object} token
   *   @param {String} token.key Placeholder key
   *   @param {String} token.value Placeholder value
   * @return {String} param or token.value when params are missing
   */
  get({ key, value }) {
    if (!this.params) {
      return value;
    }
    if (key) {
      return this.params[key];
    }
    return this.params[this.index++];
  }
}

const trimSpacesEnd = str => str.replace(/[ \t]+$/u, '');

class Formatter {
  /**
   * @param {Object} cfg
   *  @param {String} cfg.language
   *  @param {String} cfg.indent
   *  @param {Bool} cfg.uppercase
   *  @param {Integer} cfg.linesBetweenQueries
   *  @param {Object} cfg.params
   * @param {Tokenizer} tokenizer
   */
  constructor(cfg, tokenizer, tokenOverride) {
    this.cfg = cfg || {};
    this.indentation = new Indentation(this.cfg.indent);
    this.inlineBlock = new InlineBlock();
    this.params = new Params(this.cfg.params);
    this.tokenizer = tokenizer;
    this.tokenOverride = tokenOverride;
    this.previousReservedWord = {};
    this.tokens = [];
    this.index = 0;
  }

  /**
   * Formats whitespace in a SQL string to make it easier to read.
   *
   * @param {String} query The SQL query string
   * @return {String} formatted query
   */
  format(query) {
    this.tokens = this.tokenizer.tokenize(query);
    const formattedQuery = this.getFormattedQueryFromTokens();

    return formattedQuery.trim();
  }

  getFormattedQueryFromTokens() {
    let formattedQuery = '';

    this.tokens.forEach((token, index) => {
      this.index = index;

      if (this.tokenOverride) token = this.tokenOverride(token, this.previousReservedWord) || token;

      if (token.type === tokenTypes.WHITESPACE) ; else if (token.type === tokenTypes.LINE_COMMENT) {
        formattedQuery = this.formatLineComment(token, formattedQuery);
      } else if (token.type === tokenTypes.BLOCK_COMMENT) {
        formattedQuery = this.formatBlockComment(token, formattedQuery);
      } else if (token.type === tokenTypes.RESERVED_TOP_LEVEL) {
        formattedQuery = this.formatTopLevelReservedWord(token, formattedQuery);
        this.previousReservedWord = token;
      } else if (token.type === tokenTypes.RESERVED_TOP_LEVEL_NO_INDENT) {
        formattedQuery = this.formatTopLevelReservedWordNoIndent(token, formattedQuery);
        this.previousReservedWord = token;
      } else if (token.type === tokenTypes.RESERVED_NEWLINE) {
        formattedQuery = this.formatNewlineReservedWord(token, formattedQuery);
        this.previousReservedWord = token;
      } else if (token.type === tokenTypes.RESERVED) {
        formattedQuery = this.formatWithSpaces(token, formattedQuery);
        this.previousReservedWord = token;
      } else if (token.type === tokenTypes.OPEN_PAREN) {
        formattedQuery = this.formatOpeningParentheses(token, formattedQuery);
      } else if (token.type === tokenTypes.CLOSE_PAREN) {
        formattedQuery = this.formatClosingParentheses(token, formattedQuery);
      } else if (token.type === tokenTypes.PLACEHOLDER) {
        formattedQuery = this.formatPlaceholder(token, formattedQuery);
      } else if (token.value === ',') {
        formattedQuery = this.formatComma(token, formattedQuery);
      } else if (token.value === ':') {
        formattedQuery = this.formatWithSpaceAfter(token, formattedQuery);
      } else if (token.value === '.') {
        formattedQuery = this.formatWithoutSpaces(token, formattedQuery);
      } else if (token.value === ';') {
        formattedQuery = this.formatQuerySeparator(token, formattedQuery);
      } else {
        formattedQuery = this.formatWithSpaces(token, formattedQuery);
      }
    });
    return formattedQuery;
  }

  formatLineComment(token, query) {
    return this.addNewline(query + token.value);
  }

  formatBlockComment(token, query) {
    return this.addNewline(this.addNewline(query) + this.indentComment(token.value));
  }

  indentComment(comment) {
    return comment.replace(/\n[ \t]*/gu, '\n' + this.indentation.getIndent() + ' ');
  }

  formatTopLevelReservedWordNoIndent(token, query) {
    this.indentation.decreaseTopLevel();
    query = this.addNewline(query) + this.equalizeWhitespace(this.formatReservedWord(token.value));
    return this.addNewline(query);
  }

  formatTopLevelReservedWord(token, query) {
    this.indentation.decreaseTopLevel();

    query = this.addNewline(query);

    this.indentation.increaseTopLevel();

    query += this.equalizeWhitespace(this.formatReservedWord(token.value));
    return this.addNewline(query);
  }

  formatNewlineReservedWord(token, query) {
    return (
      this.addNewline(query) + this.equalizeWhitespace(this.formatReservedWord(token.value)) + ' '
    );
  }

  // Replace any sequence of whitespace characters with single space
  equalizeWhitespace(string) {
    return string.replace(/\s+/gu, ' ');
  }

  // Opening parentheses increase the block indent level and start a new line
  formatOpeningParentheses(token, query) {
    // Take out the preceding space unless there was whitespace there in the original query
    // or another opening parens or line comment
    const preserveWhitespaceFor = [
      tokenTypes.WHITESPACE,
      tokenTypes.OPEN_PAREN,
      tokenTypes.LINE_COMMENT
    ];
    if (!preserveWhitespaceFor.includes(this.previousToken().type)) {
      query = trimSpacesEnd(query);
    }
    query += this.cfg.uppercase ? token.value.toUpperCase() : token.value;

    this.inlineBlock.beginIfPossible(this.tokens, this.index);

    if (!this.inlineBlock.isActive()) {
      this.indentation.increaseBlockLevel();
      query = this.addNewline(query);
    }
    return query;
  }

  // Closing parentheses decrease the block indent level
  formatClosingParentheses(token, query) {
    token.value = this.cfg.uppercase ? token.value.toUpperCase() : token.value;
    if (this.inlineBlock.isActive()) {
      this.inlineBlock.end();
      return this.formatWithSpaceAfter(token, query);
    } else {
      this.indentation.decreaseBlockLevel();
      return this.formatWithSpaces(token, this.addNewline(query));
    }
  }

  formatPlaceholder(token, query) {
    return query + this.params.get(token) + ' ';
  }

  // Commas start a new line (unless within inline parentheses or SQL "LIMIT" clause)
  formatComma(token, query) {
    query = trimSpacesEnd(query) + token.value + ' ';

    if (this.inlineBlock.isActive()) {
      return query;
    } else if (/^LIMIT$/iu.test(this.previousReservedWord.value)) {
      return query;
    } else {
      return this.addNewline(query);
    }
  }

  formatWithSpaceAfter(token, query) {
    return trimSpacesEnd(query) + token.value + ' ';
  }

  formatWithoutSpaces(token, query) {
    return trimSpacesEnd(query) + token.value;
  }

  formatWithSpaces(token, query) {
    const value = token.type === 'reserved' ? this.formatReservedWord(token.value) : token.value;
    return query + value + ' ';
  }

  formatReservedWord(value) {
    return this.cfg.uppercase ? value.toUpperCase() : value;
  }

  formatQuerySeparator(token, query) {
    this.indentation.resetIndentation();
    return trimSpacesEnd(query) + token.value + '\n'.repeat(this.cfg.linesBetweenQueries || 1);
  }

  addNewline(query) {
    query = trimSpacesEnd(query);
    if (!query.endsWith('\n')) query += '\n';
    return query + this.indentation.getIndent();
  }

  previousToken(offset = 1) {
    return this.tokens[this.index - offset] || {};
  }
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions#escaping
const escapeRegExp = str => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class Tokenizer {
  /**
   * @param {Object} cfg
   *  @param {String[]} cfg.reservedWords Reserved words in SQL
   *  @param {String[]} cfg.reservedTopLevelWords Words that are set to new line separately
   *  @param {String[]} cfg.reservedNewlineWords Words that are set to newline
   *  @param {String[]} cfg.reservedTopLevelWordsNoIndent Words that are top level but have no indentation
   *  @param {String[]} cfg.stringTypes String types to enable: "", '', ``, [], N''
   *  @param {String[]} cfg.openParens Opening parentheses to enable, like (, [
   *  @param {String[]} cfg.closeParens Closing parentheses to enable, like ), ]
   *  @param {String[]} cfg.indexedPlaceholderTypes Prefixes for indexed placeholders, like ?
   *  @param {String[]} cfg.namedPlaceholderTypes Prefixes for named placeholders, like @ and :
   *  @param {String[]} cfg.lineCommentTypes Line comments to enable, like # and --
   *  @param {String[]} cfg.specialWordChars Special chars that can be found inside of words, like @ and #
   */
  constructor(cfg) {
    this.WHITESPACE_REGEX = /^(\s+)/u;
    this.NUMBER_REGEX = /^((-\s*)?[0-9]+(\.[0-9]+)?|0x[0-9a-fA-F]+|0b[01]+)\b/u;
    this.OPERATOR_REGEX = /^(!=|<>|==|<=|>=|!<|!>|\|\||::|->>|->|~~\*|~~|!~~\*|!~~|~\*|!~\*|!~|:=|.)/u;

    this.BLOCK_COMMENT_REGEX = /^(\/\*[^]*?(?:\*\/|$))/u;
    this.LINE_COMMENT_REGEX = this.createLineCommentRegex(cfg.lineCommentTypes);

    this.RESERVED_TOP_LEVEL_REGEX = this.createReservedWordRegex(cfg.reservedTopLevelWords);
    this.RESERVED_TOP_LEVEL_NO_INDENT_REGEX = this.createReservedWordRegex(
      cfg.reservedTopLevelWordsNoIndent
    );
    this.RESERVED_NEWLINE_REGEX = this.createReservedWordRegex(cfg.reservedNewlineWords);
    this.RESERVED_PLAIN_REGEX = this.createReservedWordRegex(cfg.reservedWords);

    this.WORD_REGEX = this.createWordRegex(cfg.specialWordChars);
    this.STRING_REGEX = this.createStringRegex(cfg.stringTypes);

    this.OPEN_PAREN_REGEX = this.createParenRegex(cfg.openParens);
    this.CLOSE_PAREN_REGEX = this.createParenRegex(cfg.closeParens);

    this.INDEXED_PLACEHOLDER_REGEX = this.createPlaceholderRegex(
      cfg.indexedPlaceholderTypes,
      '[0-9]*'
    );
    this.IDENT_NAMED_PLACEHOLDER_REGEX = this.createPlaceholderRegex(
      cfg.namedPlaceholderTypes,
      '[a-zA-Z0-9._$]+'
    );
    this.STRING_NAMED_PLACEHOLDER_REGEX = this.createPlaceholderRegex(
      cfg.namedPlaceholderTypes,
      this.createStringPattern(cfg.stringTypes)
    );
  }

  createLineCommentRegex(lineCommentTypes) {
    return new RegExp(
      `^((?:${lineCommentTypes.map(c => escapeRegExp(c)).join('|')}).*?(?:\r\n|\r|\n|$))`,
      'u'
    );
  }

  createReservedWordRegex(reservedWords) {
    const reservedWordsPattern = reservedWords.join('|').replace(/ /gu, '\\s+');
    return new RegExp(`^(${reservedWordsPattern})\\b`, 'iu');
  }

  createWordRegex(specialChars = []) {
    return new RegExp(
      `^([\\p{Alphabetic}\\p{Mark}\\p{Decimal_Number}\\p{Connector_Punctuation}\\p{Join_Control}${specialChars.join(
        ''
      )}]+)`,
      'u'
    );
  }

  createStringRegex(stringTypes) {
    return new RegExp('^(' + this.createStringPattern(stringTypes) + ')', 'u');
  }

  // This enables the following string patterns:
  // 1. backtick quoted string using `` to escape
  // 2. square bracket quoted string (SQL Server) using ]] to escape
  // 3. double quoted string using "" or \" to escape
  // 4. single quoted string using '' or \' to escape
  // 5. national character quoted string using N'' or N\' to escape
  createStringPattern(stringTypes) {
    const patterns = {
      '``': '((`[^`]*($|`))+)',
      '[]': '((\\[[^\\]]*($|\\]))(\\][^\\]]*($|\\]))*)',
      '""': '(("[^"\\\\]*(?:\\\\.[^"\\\\]*)*("|$))+)',
      "''": "(('[^'\\\\]*(?:\\\\.[^'\\\\]*)*('|$))+)",
      "N''": "((N'[^N'\\\\]*(?:\\\\.[^N'\\\\]*)*('|$))+)"
    };

    return stringTypes.map(t => patterns[t]).join('|');
  }

  createParenRegex(parens) {
    return new RegExp('^(' + parens.map(p => this.escapeParen(p)).join('|') + ')', 'iu');
  }

  escapeParen(paren) {
    if (paren.length === 1) {
      // A single punctuation character
      return escapeRegExp(paren);
    } else {
      // longer word
      return '\\b' + paren + '\\b';
    }
  }

  createPlaceholderRegex(types, pattern) {
    if (types == null) {
      return false;
    }
    const typesRegex = types.map(escapeRegExp).join('|');

    return new RegExp(`^((?:${typesRegex})(?:${pattern}))`, 'u');
  }

  /**
   * Takes a SQL string and breaks it into tokens.
   * Each token is an object with type and value.
   *
   * @param {String} input The SQL string
   * @return {Object[]} tokens An array of tokens.
   *  @return {String} token.type
   *  @return {String} token.value
   */
  tokenize(input) {
    if (!input) return [];

    const tokens = [];
    let token;

    // Keep processing the string until it is empty
    while (input.length) {
      // Get the next token and the token type
      token = this.getNextToken(input, token);
      // Advance the string
      input = input.substring(token.value.length);

      tokens.push(token);
    }
    return tokens;
  }

  getNextToken(input, previousToken) {
    return (
      this.getWhitespaceToken(input) ||
      this.getCommentToken(input) ||
      this.getStringToken(input) ||
      this.getOpenParenToken(input) ||
      this.getCloseParenToken(input) ||
      this.getPlaceholderToken(input) ||
      this.getNumberToken(input) ||
      this.getReservedWordToken(input, previousToken) ||
      this.getWordToken(input) ||
      this.getOperatorToken(input)
    );
  }

  getWhitespaceToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.WHITESPACE,
      regex: this.WHITESPACE_REGEX
    });
  }

  getCommentToken(input) {
    return this.getLineCommentToken(input) || this.getBlockCommentToken(input);
  }

  getLineCommentToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.LINE_COMMENT,
      regex: this.LINE_COMMENT_REGEX
    });
  }

  getBlockCommentToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.BLOCK_COMMENT,
      regex: this.BLOCK_COMMENT_REGEX
    });
  }

  getStringToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.STRING,
      regex: this.STRING_REGEX
    });
  }

  getOpenParenToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.OPEN_PAREN,
      regex: this.OPEN_PAREN_REGEX
    });
  }

  getCloseParenToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.CLOSE_PAREN,
      regex: this.CLOSE_PAREN_REGEX
    });
  }

  getPlaceholderToken(input) {
    return (
      this.getIdentNamedPlaceholderToken(input) ||
      this.getStringNamedPlaceholderToken(input) ||
      this.getIndexedPlaceholderToken(input)
    );
  }

  getIdentNamedPlaceholderToken(input) {
    return this.getPlaceholderTokenWithKey({
      input,
      regex: this.IDENT_NAMED_PLACEHOLDER_REGEX,
      parseKey: v => v.slice(1)
    });
  }

  getStringNamedPlaceholderToken(input) {
    return this.getPlaceholderTokenWithKey({
      input,
      regex: this.STRING_NAMED_PLACEHOLDER_REGEX,
      parseKey: v => this.getEscapedPlaceholderKey({ key: v.slice(2, -1), quoteChar: v.slice(-1) })
    });
  }

  getIndexedPlaceholderToken(input) {
    return this.getPlaceholderTokenWithKey({
      input,
      regex: this.INDEXED_PLACEHOLDER_REGEX,
      parseKey: v => v.slice(1)
    });
  }

  getPlaceholderTokenWithKey({ input, regex, parseKey }) {
    const token = this.getTokenOnFirstMatch({ input, regex, type: tokenTypes.PLACEHOLDER });
    if (token) {
      token.key = parseKey(token.value);
    }
    return token;
  }

  getEscapedPlaceholderKey({ key, quoteChar }) {
    return key.replace(new RegExp(escapeRegExp('\\' + quoteChar), 'gu'), quoteChar);
  }

  // Decimal, binary, or hex numbers
  getNumberToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.NUMBER,
      regex: this.NUMBER_REGEX
    });
  }

  // Punctuation and symbols
  getOperatorToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.OPERATOR,
      regex: this.OPERATOR_REGEX
    });
  }

  getReservedWordToken(input, previousToken) {
    // A reserved word cannot be preceded by a "."
    // this makes it so in "my_table.from", "from" is not considered a reserved word
    if (previousToken && previousToken.value && previousToken.value === '.') {
      return;
    }
    return (
      this.getTopLevelReservedToken(input) ||
      this.getNewlineReservedToken(input) ||
      this.getTopLevelReservedTokenNoIndent(input) ||
      this.getPlainReservedToken(input)
    );
  }

  getTopLevelReservedToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.RESERVED_TOP_LEVEL,
      regex: this.RESERVED_TOP_LEVEL_REGEX
    });
  }

  getNewlineReservedToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.RESERVED_NEWLINE,
      regex: this.RESERVED_NEWLINE_REGEX
    });
  }

  getTopLevelReservedTokenNoIndent(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.RESERVED_TOP_LEVEL_NO_INDENT,
      regex: this.RESERVED_TOP_LEVEL_NO_INDENT_REGEX
    });
  }

  getPlainReservedToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.RESERVED,
      regex: this.RESERVED_PLAIN_REGEX
    });
  }

  getWordToken(input) {
    return this.getTokenOnFirstMatch({
      input,
      type: tokenTypes.WORD,
      regex: this.WORD_REGEX
    });
  }

  getTokenOnFirstMatch({ input, type, regex }) {
    const matches = input.match(regex);

    if (matches) {
      return { type, value: matches[1] };
    }
  }
}

const reservedWords$3 = [
  'ABS',
  'ACTIVATE',
  'ALIAS',
  'ALL',
  'ALLOCATE',
  'ALLOW',
  'ALTER',
  'ANY',
  'ARE',
  'ARRAY',
  'AS',
  'ASC',
  'ASENSITIVE',
  'ASSOCIATE',
  'ASUTIME',
  'ASYMMETRIC',
  'AT',
  'ATOMIC',
  'ATTRIBUTES',
  'AUDIT',
  'AUTHORIZATION',
  'AUX',
  'AUXILIARY',
  'AVG',
  'BEFORE',
  'BEGIN',
  'BETWEEN',
  'BIGINT',
  'BINARY',
  'BLOB',
  'BOOLEAN',
  'BOTH',
  'BUFFERPOOL',
  'BY',
  'CACHE',
  'CALL',
  'CALLED',
  'CAPTURE',
  'CARDINALITY',
  'CASCADED',
  'CASE',
  'CAST',
  'CCSID',
  'CEIL',
  'CEILING',
  'CHAR',
  'CHARACTER',
  'CHARACTER_LENGTH',
  'CHAR_LENGTH',
  'CHECK',
  'CLOB',
  'CLONE',
  'CLOSE',
  'CLUSTER',
  'COALESCE',
  'COLLATE',
  'COLLECT',
  'COLLECTION',
  'COLLID',
  'COLUMN',
  'COMMENT',
  'COMMIT',
  'CONCAT',
  'CONDITION',
  'CONNECT',
  'CONNECTION',
  'CONSTRAINT',
  'CONTAINS',
  'CONTINUE',
  'CONVERT',
  'CORR',
  'CORRESPONDING',
  'COUNT',
  'COUNT_BIG',
  'COVAR_POP',
  'COVAR_SAMP',
  'CREATE',
  'CROSS',
  'CUBE',
  'CUME_DIST',
  'CURRENT',
  'CURRENT_DATE',
  'CURRENT_DEFAULT_TRANSFORM_GROUP',
  'CURRENT_LC_CTYPE',
  'CURRENT_PATH',
  'CURRENT_ROLE',
  'CURRENT_SCHEMA',
  'CURRENT_SERVER',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'CURRENT_TIMEZONE',
  'CURRENT_TRANSFORM_GROUP_FOR_TYPE',
  'CURRENT_USER',
  'CURSOR',
  'CYCLE',
  'DATA',
  'DATABASE',
  'DATAPARTITIONNAME',
  'DATAPARTITIONNUM',
  'DATE',
  'DAY',
  'DAYS',
  'DB2GENERAL',
  'DB2GENRL',
  'DB2SQL',
  'DBINFO',
  'DBPARTITIONNAME',
  'DBPARTITIONNUM',
  'DEALLOCATE',
  'DEC',
  'DECIMAL',
  'DECLARE',
  'DEFAULT',
  'DEFAULTS',
  'DEFINITION',
  'DELETE',
  'DENSERANK',
  'DENSE_RANK',
  'DEREF',
  'DESCRIBE',
  'DESCRIPTOR',
  'DETERMINISTIC',
  'DIAGNOSTICS',
  'DISABLE',
  'DISALLOW',
  'DISCONNECT',
  'DISTINCT',
  'DO',
  'DOCUMENT',
  'DOUBLE',
  'DROP',
  'DSSIZE',
  'DYNAMIC',
  'EACH',
  'EDITPROC',
  'ELEMENT',
  'ELSE',
  'ELSEIF',
  'ENABLE',
  'ENCODING',
  'ENCRYPTION',
  'END',
  'END-EXEC',
  'ENDING',
  'ERASE',
  'ESCAPE',
  'EVERY',
  'EXCEPTION',
  'EXCLUDING',
  'EXCLUSIVE',
  'EXEC',
  'EXECUTE',
  'EXISTS',
  'EXIT',
  'EXP',
  'EXPLAIN',
  'EXTENDED',
  'EXTERNAL',
  'EXTRACT',
  'FALSE',
  'FENCED',
  'FETCH',
  'FIELDPROC',
  'FILE',
  'FILTER',
  'FINAL',
  'FIRST',
  'FLOAT',
  'FLOOR',
  'FOR',
  'FOREIGN',
  'FREE',
  'FULL',
  'FUNCTION',
  'FUSION',
  'GENERAL',
  'GENERATED',
  'GET',
  'GLOBAL',
  'GOTO',
  'GRANT',
  'GRAPHIC',
  'GROUP',
  'GROUPING',
  'HANDLER',
  'HASH',
  'HASHED_VALUE',
  'HINT',
  'HOLD',
  'HOUR',
  'HOURS',
  'IDENTITY',
  'IF',
  'IMMEDIATE',
  'IN',
  'INCLUDING',
  'INCLUSIVE',
  'INCREMENT',
  'INDEX',
  'INDICATOR',
  'INDICATORS',
  'INF',
  'INFINITY',
  'INHERIT',
  'INNER',
  'INOUT',
  'INSENSITIVE',
  'INSERT',
  'INT',
  'INTEGER',
  'INTEGRITY',
  'INTERSECTION',
  'INTERVAL',
  'INTO',
  'IS',
  'ISOBID',
  'ISOLATION',
  'ITERATE',
  'JAR',
  'JAVA',
  'KEEP',
  'KEY',
  'LABEL',
  'LANGUAGE',
  'LARGE',
  'LATERAL',
  'LC_CTYPE',
  'LEADING',
  'LEAVE',
  'LEFT',
  'LIKE',
  'LINKTYPE',
  'LN',
  'LOCAL',
  'LOCALDATE',
  'LOCALE',
  'LOCALTIME',
  'LOCALTIMESTAMP',
  'LOCATOR',
  'LOCATORS',
  'LOCK',
  'LOCKMAX',
  'LOCKSIZE',
  'LONG',
  'LOOP',
  'LOWER',
  'MAINTAINED',
  'MATCH',
  'MATERIALIZED',
  'MAX',
  'MAXVALUE',
  'MEMBER',
  'MERGE',
  'METHOD',
  'MICROSECOND',
  'MICROSECONDS',
  'MIN',
  'MINUTE',
  'MINUTES',
  'MINVALUE',
  'MOD',
  'MODE',
  'MODIFIES',
  'MODULE',
  'MONTH',
  'MONTHS',
  'MULTISET',
  'NAN',
  'NATIONAL',
  'NATURAL',
  'NCHAR',
  'NCLOB',
  'NEW',
  'NEW_TABLE',
  'NEXTVAL',
  'NO',
  'NOCACHE',
  'NOCYCLE',
  'NODENAME',
  'NODENUMBER',
  'NOMAXVALUE',
  'NOMINVALUE',
  'NONE',
  'NOORDER',
  'NORMALIZE',
  'NORMALIZED',
  'NOT',
  'NULL',
  'NULLIF',
  'NULLS',
  'NUMERIC',
  'NUMPARTS',
  'OBID',
  'OCTET_LENGTH',
  'OF',
  'OFFSET',
  'OLD',
  'OLD_TABLE',
  'ON',
  'ONLY',
  'OPEN',
  'OPTIMIZATION',
  'OPTIMIZE',
  'OPTION',
  'ORDER',
  'OUT',
  'OUTER',
  'OVER',
  'OVERLAPS',
  'OVERLAY',
  'OVERRIDING',
  'PACKAGE',
  'PADDED',
  'PAGESIZE',
  'PARAMETER',
  'PART',
  'PARTITION',
  'PARTITIONED',
  'PARTITIONING',
  'PARTITIONS',
  'PASSWORD',
  'PATH',
  'PERCENTILE_CONT',
  'PERCENTILE_DISC',
  'PERCENT_RANK',
  'PIECESIZE',
  'PLAN',
  'POSITION',
  'POWER',
  'PRECISION',
  'PREPARE',
  'PREVVAL',
  'PRIMARY',
  'PRIQTY',
  'PRIVILEGES',
  'PROCEDURE',
  'PROGRAM',
  'PSID',
  'PUBLIC',
  'QUERY',
  'QUERYNO',
  'RANGE',
  'RANK',
  'READ',
  'READS',
  'REAL',
  'RECOVERY',
  'RECURSIVE',
  'REF',
  'REFERENCES',
  'REFERENCING',
  'REFRESH',
  'REGR_AVGX',
  'REGR_AVGY',
  'REGR_COUNT',
  'REGR_INTERCEPT',
  'REGR_R2',
  'REGR_SLOPE',
  'REGR_SXX',
  'REGR_SXY',
  'REGR_SYY',
  'RELEASE',
  'RENAME',
  'REPEAT',
  'RESET',
  'RESIGNAL',
  'RESTART',
  'RESTRICT',
  'RESULT',
  'RESULT_SET_LOCATOR',
  'RETURN',
  'RETURNS',
  'REVOKE',
  'RIGHT',
  'ROLE',
  'ROLLBACK',
  'ROLLUP',
  'ROUND_CEILING',
  'ROUND_DOWN',
  'ROUND_FLOOR',
  'ROUND_HALF_DOWN',
  'ROUND_HALF_EVEN',
  'ROUND_HALF_UP',
  'ROUND_UP',
  'ROUTINE',
  'ROW',
  'ROWNUMBER',
  'ROWS',
  'ROWSET',
  'ROW_NUMBER',
  'RRN',
  'RUN',
  'SAVEPOINT',
  'SCHEMA',
  'SCOPE',
  'SCRATCHPAD',
  'SCROLL',
  'SEARCH',
  'SECOND',
  'SECONDS',
  'SECQTY',
  'SECURITY',
  'SENSITIVE',
  'SEQUENCE',
  'SESSION',
  'SESSION_USER',
  'SIGNAL',
  'SIMILAR',
  'SIMPLE',
  'SMALLINT',
  'SNAN',
  'SOME',
  'SOURCE',
  'SPECIFIC',
  'SPECIFICTYPE',
  'SQL',
  'SQLEXCEPTION',
  'SQLID',
  'SQLSTATE',
  'SQLWARNING',
  'SQRT',
  'STACKED',
  'STANDARD',
  'START',
  'STARTING',
  'STATEMENT',
  'STATIC',
  'STATMENT',
  'STAY',
  'STDDEV_POP',
  'STDDEV_SAMP',
  'STOGROUP',
  'STORES',
  'STYLE',
  'SUBMULTISET',
  'SUBSTRING',
  'SUM',
  'SUMMARY',
  'SYMMETRIC',
  'SYNONYM',
  'SYSFUN',
  'SYSIBM',
  'SYSPROC',
  'SYSTEM',
  'SYSTEM_USER',
  'TABLE',
  'TABLESAMPLE',
  'TABLESPACE',
  'THEN',
  'TIME',
  'TIMESTAMP',
  'TIMEZONE_HOUR',
  'TIMEZONE_MINUTE',
  'TO',
  'TRAILING',
  'TRANSACTION',
  'TRANSLATE',
  'TRANSLATION',
  'TREAT',
  'TRIGGER',
  'TRIM',
  'TRUE',
  'TRUNCATE',
  'TYPE',
  'UESCAPE',
  'UNDO',
  'UNIQUE',
  'UNKNOWN',
  'UNNEST',
  'UNTIL',
  'UPPER',
  'USAGE',
  'USER',
  'USING',
  'VALIDPROC',
  'VALUE',
  'VARCHAR',
  'VARIABLE',
  'VARIANT',
  'VARYING',
  'VAR_POP',
  'VAR_SAMP',
  'VCAT',
  'VERSION',
  'VIEW',
  'VOLATILE',
  'VOLUMES',
  'WHEN',
  'WHENEVER',
  'WHILE',
  'WIDTH_BUCKET',
  'WINDOW',
  'WITH',
  'WITHIN',
  'WITHOUT',
  'WLM',
  'WRITE',
  'XMLELEMENT',
  'XMLEXISTS',
  'XMLNAMESPACES',
  'YEAR',
  'YEARS'
];

const reservedTopLevelWords$3 = [
  'ADD',
  'AFTER',
  'ALTER COLUMN',
  'ALTER TABLE',
  'DELETE FROM',
  'EXCEPT',
  'FETCH FIRST',
  'FROM',
  'GROUP BY',
  'GO',
  'HAVING',
  'INSERT INTO',
  'INTERSECT',
  'LIMIT',
  'ORDER BY',
  'SELECT',
  'SET CURRENT SCHEMA',
  'SET SCHEMA',
  'SET',
  'UPDATE',
  'VALUES',
  'WHERE'
];

const reservedTopLevelWordsNoIndent$3 = ['INTERSECT', 'INTERSECT ALL', 'MINUS', 'UNION', 'UNION ALL'];

const reservedNewlineWords$3 = [
  'AND',
  'CROSS JOIN',
  'INNER JOIN',
  'JOIN',
  'LEFT JOIN',
  'LEFT OUTER JOIN',
  'OR',
  'OUTER JOIN',
  'RIGHT JOIN',
  'RIGHT OUTER JOIN'
];

let tokenizer$3;

class Db2Formatter {
  /**
   * @param {Object} cfg Different set of configurations
   */
  constructor(cfg) {
    this.cfg = cfg;
  }

  /**
   * Formats DB2 query to make it easier to read
   *
   * @param {String} query The DB2 query string
   * @return {String} formatted string
   */
  format(query) {
    if (!tokenizer$3) {
      tokenizer$3 = new Tokenizer({
        reservedWords: reservedWords$3,
        reservedTopLevelWords: reservedTopLevelWords$3,
        reservedNewlineWords: reservedNewlineWords$3,
        reservedTopLevelWordsNoIndent: reservedTopLevelWordsNoIndent$3,
        stringTypes: [`""`, "''", '``', '[]'],
        openParens: ['('],
        closeParens: [')'],
        indexedPlaceholderTypes: ['?'],
        namedPlaceholderTypes: [':'],
        lineCommentTypes: ['--'],
        specialWordChars: ['#', '@']
      });
    }
    return new Formatter(this.cfg, tokenizer$3).format(query);
  }
}

const reservedWords$2 = [
  'ALL',
  'ALTER',
  'ANALYZE',
  'AND',
  'ANY',
  'ARRAY',
  'AS',
  'ASC',
  'BEGIN',
  'BETWEEN',
  'BINARY',
  'BOOLEAN',
  'BREAK',
  'BUCKET',
  'BUILD',
  'BY',
  'CALL',
  'CASE',
  'CAST',
  'CLUSTER',
  'COLLATE',
  'COLLECTION',
  'COMMIT',
  'CONNECT',
  'CONTINUE',
  'CORRELATE',
  'COVER',
  'CREATE',
  'DATABASE',
  'DATASET',
  'DATASTORE',
  'DECLARE',
  'DECREMENT',
  'DELETE',
  'DERIVED',
  'DESC',
  'DESCRIBE',
  'DISTINCT',
  'DO',
  'DROP',
  'EACH',
  'ELEMENT',
  'ELSE',
  'END',
  'EVERY',
  'EXCEPT',
  'EXCLUDE',
  'EXECUTE',
  'EXISTS',
  'EXPLAIN',
  'FALSE',
  'FETCH',
  'FIRST',
  'FLATTEN',
  'FOR',
  'FORCE',
  'FROM',
  'FUNCTION',
  'GRANT',
  'GROUP',
  'GSI',
  'HAVING',
  'IF',
  'IGNORE',
  'ILIKE',
  'IN',
  'INCLUDE',
  'INCREMENT',
  'INDEX',
  'INFER',
  'INLINE',
  'INNER',
  'INSERT',
  'INTERSECT',
  'INTO',
  'IS',
  'JOIN',
  'KEY',
  'KEYS',
  'KEYSPACE',
  'KNOWN',
  'LAST',
  'LEFT',
  'LET',
  'LETTING',
  'LIKE',
  'LIMIT',
  'LSM',
  'MAP',
  'MAPPING',
  'MATCHED',
  'MATERIALIZED',
  'MERGE',
  'MISSING',
  'NAMESPACE',
  'NEST',
  'NOT',
  'NULL',
  'NUMBER',
  'OBJECT',
  'OFFSET',
  'ON',
  'OPTION',
  'OR',
  'ORDER',
  'OUTER',
  'OVER',
  'PARSE',
  'PARTITION',
  'PASSWORD',
  'PATH',
  'POOL',
  'PREPARE',
  'PRIMARY',
  'PRIVATE',
  'PRIVILEGE',
  'PROCEDURE',
  'PUBLIC',
  'RAW',
  'REALM',
  'REDUCE',
  'RENAME',
  'RETURN',
  'RETURNING',
  'REVOKE',
  'RIGHT',
  'ROLE',
  'ROLLBACK',
  'SATISFIES',
  'SCHEMA',
  'SELECT',
  'SELF',
  'SEMI',
  'SET',
  'SHOW',
  'SOME',
  'START',
  'STATISTICS',
  'STRING',
  'SYSTEM',
  'THEN',
  'TO',
  'TRANSACTION',
  'TRIGGER',
  'TRUE',
  'TRUNCATE',
  'UNDER',
  'UNION',
  'UNIQUE',
  'UNKNOWN',
  'UNNEST',
  'UNSET',
  'UPDATE',
  'UPSERT',
  'USE',
  'USER',
  'USING',
  'VALIDATE',
  'VALUE',
  'VALUED',
  'VALUES',
  'VIA',
  'VIEW',
  'WHEN',
  'WHERE',
  'WHILE',
  'WITH',
  'WITHIN',
  'WORK',
  'XOR'
];

const reservedTopLevelWords$2 = [
  'DELETE FROM',
  'EXCEPT ALL',
  'EXCEPT',
  'EXPLAIN DELETE FROM',
  'EXPLAIN UPDATE',
  'EXPLAIN UPSERT',
  'FROM',
  'GROUP BY',
  'HAVING',
  'INFER',
  'INSERT INTO',
  'LET',
  'LIMIT',
  'MERGE',
  'NEST',
  'ORDER BY',
  'PREPARE',
  'SELECT',
  'SET CURRENT SCHEMA',
  'SET SCHEMA',
  'SET',
  'UNNEST',
  'UPDATE',
  'UPSERT',
  'USE KEYS',
  'VALUES',
  'WHERE'
];

const reservedTopLevelWordsNoIndent$2 = ['INTERSECT', 'INTERSECT ALL', 'MINUS', 'UNION', 'UNION ALL'];

const reservedNewlineWords$2 = [
  'AND',
  'INNER JOIN',
  'JOIN',
  'LEFT JOIN',
  'LEFT OUTER JOIN',
  'OR',
  'OUTER JOIN',
  'RIGHT JOIN',
  'RIGHT OUTER JOIN',
  'XOR'
];

let tokenizer$2;

class N1qlFormatter {
  /**
   * @param {Object} cfg Different set of configurations
   */
  constructor(cfg) {
    this.cfg = cfg;
  }

  /**
   * Format the whitespace in a N1QL string to make it easier to read
   *
   * @param {String} query The N1QL string
   * @return {String} formatted string
   */
  format(query) {
    if (!tokenizer$2) {
      tokenizer$2 = new Tokenizer({
        reservedWords: reservedWords$2,
        reservedTopLevelWords: reservedTopLevelWords$2,
        reservedNewlineWords: reservedNewlineWords$2,
        reservedTopLevelWordsNoIndent: reservedTopLevelWordsNoIndent$2,
        stringTypes: [`""`, "''", '``'],
        openParens: ['(', '[', '{'],
        closeParens: [')', ']', '}'],
        namedPlaceholderTypes: ['$'],
        lineCommentTypes: ['#', '--']
      });
    }
    return new Formatter(this.cfg, tokenizer$2).format(query);
  }
}

const reservedWords$1 = [
  'A',
  'ACCESSIBLE',
  'AGENT',
  'AGGREGATE',
  'ALL',
  'ALTER',
  'ANY',
  'ARRAY',
  'AS',
  'ASC',
  'AT',
  'ATTRIBUTE',
  'AUTHID',
  'AVG',
  'BETWEEN',
  'BFILE_BASE',
  'BINARY_INTEGER',
  'BINARY',
  'BLOB_BASE',
  'BLOCK',
  'BODY',
  'BOOLEAN',
  'BOTH',
  'BOUND',
  'BREADTH',
  'BULK',
  'BY',
  'BYTE',
  'C',
  'CALL',
  'CALLING',
  'CASCADE',
  'CASE',
  'CHAR_BASE',
  'CHAR',
  'CHARACTER',
  'CHARSET',
  'CHARSETFORM',
  'CHARSETID',
  'CHECK',
  'CLOB_BASE',
  'CLONE',
  'CLOSE',
  'CLUSTER',
  'CLUSTERS',
  'COALESCE',
  'COLAUTH',
  'COLLECT',
  'COLUMNS',
  'COMMENT',
  'COMMIT',
  'COMMITTED',
  'COMPILED',
  'COMPRESS',
  'CONNECT',
  'CONSTANT',
  'CONSTRUCTOR',
  'CONTEXT',
  'CONTINUE',
  'CONVERT',
  'COUNT',
  'CRASH',
  'CREATE',
  'CREDENTIAL',
  'CURRENT',
  'CURRVAL',
  'CURSOR',
  'CUSTOMDATUM',
  'DANGLING',
  'DATA',
  'DATE_BASE',
  'DATE',
  'DAY',
  'DECIMAL',
  'DEFAULT',
  'DEFINE',
  'DELETE',
  'DEPTH',
  'DESC',
  'DETERMINISTIC',
  'DIRECTORY',
  'DISTINCT',
  'DO',
  'DOUBLE',
  'DROP',
  'DURATION',
  'ELEMENT',
  'ELSIF',
  'EMPTY',
  'END',
  'ESCAPE',
  'EXCEPTIONS',
  'EXCLUSIVE',
  'EXECUTE',
  'EXISTS',
  'EXIT',
  'EXTENDS',
  'EXTERNAL',
  'EXTRACT',
  'FALSE',
  'FETCH',
  'FINAL',
  'FIRST',
  'FIXED',
  'FLOAT',
  'FOR',
  'FORALL',
  'FORCE',
  'FROM',
  'FUNCTION',
  'GENERAL',
  'GOTO',
  'GRANT',
  'GROUP',
  'HASH',
  'HEAP',
  'HIDDEN',
  'HOUR',
  'IDENTIFIED',
  'IF',
  'IMMEDIATE',
  'IN',
  'INCLUDING',
  'INDEX',
  'INDEXES',
  'INDICATOR',
  'INDICES',
  'INFINITE',
  'INSTANTIABLE',
  'INT',
  'INTEGER',
  'INTERFACE',
  'INTERVAL',
  'INTO',
  'INVALIDATE',
  'IS',
  'ISOLATION',
  'JAVA',
  'LANGUAGE',
  'LARGE',
  'LEADING',
  'LENGTH',
  'LEVEL',
  'LIBRARY',
  'LIKE',
  'LIKE2',
  'LIKE4',
  'LIKEC',
  'LIMITED',
  'LOCAL',
  'LOCK',
  'LONG',
  'MAP',
  'MAX',
  'MAXLEN',
  'MEMBER',
  'MERGE',
  'MIN',
  'MINUTE',
  'MLSLABEL',
  'MOD',
  'MODE',
  'MONTH',
  'MULTISET',
  'NAME',
  'NAN',
  'NATIONAL',
  'NATIVE',
  'NATURAL',
  'NATURALN',
  'NCHAR',
  'NEW',
  'NEXTVAL',
  'NOCOMPRESS',
  'NOCOPY',
  'NOT',
  'NOWAIT',
  'NULL',
  'NULLIF',
  'NUMBER_BASE',
  'NUMBER',
  'OBJECT',
  'OCICOLL',
  'OCIDATE',
  'OCIDATETIME',
  'OCIDURATION',
  'OCIINTERVAL',
  'OCILOBLOCATOR',
  'OCINUMBER',
  'OCIRAW',
  'OCIREF',
  'OCIREFCURSOR',
  'OCIROWID',
  'OCISTRING',
  'OCITYPE',
  'OF',
  'OLD',
  'ON',
  'ONLY',
  'OPAQUE',
  'OPEN',
  'OPERATOR',
  'OPTION',
  'ORACLE',
  'ORADATA',
  'ORDER',
  'ORGANIZATION',
  'ORLANY',
  'ORLVARY',
  'OTHERS',
  'OUT',
  'OVERLAPS',
  'OVERRIDING',
  'PACKAGE',
  'PARALLEL_ENABLE',
  'PARAMETER',
  'PARAMETERS',
  'PARENT',
  'PARTITION',
  'PASCAL',
  'PCTFREE',
  'PIPE',
  'PIPELINED',
  'PLS_INTEGER',
  'PLUGGABLE',
  'POSITIVE',
  'POSITIVEN',
  'PRAGMA',
  'PRECISION',
  'PRIOR',
  'PRIVATE',
  'PROCEDURE',
  'PUBLIC',
  'RAISE',
  'RANGE',
  'RAW',
  'READ',
  'REAL',
  'RECORD',
  'REF',
  'REFERENCE',
  'RELEASE',
  'RELIES_ON',
  'REM',
  'REMAINDER',
  'RENAME',
  'RESOURCE',
  'RESULT_CACHE',
  'RESULT',
  'RETURN',
  'RETURNING',
  'REVERSE',
  'REVOKE',
  'ROLLBACK',
  'ROW',
  'ROWID',
  'ROWNUM',
  'ROWTYPE',
  'SAMPLE',
  'SAVE',
  'SAVEPOINT',
  'SB1',
  'SB2',
  'SB4',
  'SEARCH',
  'SECOND',
  'SEGMENT',
  'SELF',
  'SEPARATE',
  'SEQUENCE',
  'SERIALIZABLE',
  'SHARE',
  'SHORT',
  'SIZE_T',
  'SIZE',
  'SMALLINT',
  'SOME',
  'SPACE',
  'SPARSE',
  'SQL',
  'SQLCODE',
  'SQLDATA',
  'SQLERRM',
  'SQLNAME',
  'SQLSTATE',
  'STANDARD',
  'START',
  'STATIC',
  'STDDEV',
  'STORED',
  'STRING',
  'STRUCT',
  'STYLE',
  'SUBMULTISET',
  'SUBPARTITION',
  'SUBSTITUTABLE',
  'SUBTYPE',
  'SUCCESSFUL',
  'SUM',
  'SYNONYM',
  'SYSDATE',
  'TABAUTH',
  'TABLE',
  'TDO',
  'THE',
  'THEN',
  'TIME',
  'TIMESTAMP',
  'TIMEZONE_ABBR',
  'TIMEZONE_HOUR',
  'TIMEZONE_MINUTE',
  'TIMEZONE_REGION',
  'TO',
  'TRAILING',
  'TRANSACTION',
  'TRANSACTIONAL',
  'TRIGGER',
  'TRUE',
  'TRUSTED',
  'TYPE',
  'UB1',
  'UB2',
  'UB4',
  'UID',
  'UNDER',
  'UNIQUE',
  'UNPLUG',
  'UNSIGNED',
  'UNTRUSTED',
  'USE',
  'USER',
  'USING',
  'VALIDATE',
  'VALIST',
  'VALUE',
  'VARCHAR',
  'VARCHAR2',
  'VARIABLE',
  'VARIANCE',
  'VARRAY',
  'VARYING',
  'VIEW',
  'VIEWS',
  'VOID',
  'WHENEVER',
  'WHILE',
  'WITH',
  'WORK',
  'WRAPPED',
  'WRITE',
  'YEAR',
  'ZONE'
];

const reservedTopLevelWords$1 = [
  'ADD',
  'ALTER COLUMN',
  'ALTER TABLE',
  'BEGIN',
  'CONNECT BY',
  'DECLARE',
  'DELETE FROM',
  'DELETE',
  'END',
  'EXCEPT',
  'EXCEPTION',
  'FETCH FIRST',
  'FROM',
  'GROUP BY',
  'HAVING',
  'INSERT INTO',
  'INSERT',
  'LIMIT',
  'LOOP',
  'MODIFY',
  'ORDER BY',
  'SELECT',
  'SET CURRENT SCHEMA',
  'SET SCHEMA',
  'SET',
  'START WITH',
  'UPDATE',
  'VALUES',
  'WHERE'
];

const reservedTopLevelWordsNoIndent$1 = ['INTERSECT', 'INTERSECT ALL', 'MINUS', 'UNION', 'UNION ALL'];

const reservedNewlineWords$1 = [
  'AND',
  'CROSS APPLY',
  'CROSS JOIN',
  'ELSE',
  'END',
  'INNER JOIN',
  'JOIN',
  'LEFT JOIN',
  'LEFT OUTER JOIN',
  'OR',
  'OUTER APPLY',
  'OUTER JOIN',
  'RIGHT JOIN',
  'RIGHT OUTER JOIN',
  'WHEN',
  'XOR'
];

const tokenOverride = (token, previousReservedToken) => {
  if (
    token.type === tokenTypes.RESERVED_TOP_LEVEL &&
    token.value === 'SET' &&
    previousReservedToken.value === 'BY'
  ) {
    token.type = tokenTypes.RESERVED;
    return token;
  }
};

let tokenizer$1;

class PlSqlFormatter {
  /**
   * @param {Object} cfg Different set of configurations
   */
  constructor(cfg) {
    this.cfg = cfg;
  }

  /**
   * Format the whitespace in a PL/SQL string to make it easier to read
   *
   * @param {String} query The PL/SQL string
   * @return {String} formatted string
   */
  format(query) {
    if (!tokenizer$1) {
      tokenizer$1 = new Tokenizer({
        reservedWords: reservedWords$1,
        reservedTopLevelWords: reservedTopLevelWords$1,
        reservedNewlineWords: reservedNewlineWords$1,
        reservedTopLevelWordsNoIndent: reservedTopLevelWordsNoIndent$1,
        stringTypes: [`""`, "N''", "''", '``'],
        openParens: ['(', 'CASE'],
        closeParens: [')', 'END'],
        indexedPlaceholderTypes: ['?'],
        namedPlaceholderTypes: [':'],
        lineCommentTypes: ['--'],
        specialWordChars: ['_', '$', '#', '.', '@']
      });
    }
    return new Formatter(this.cfg, tokenizer$1, tokenOverride).format(query);
  }
}

const reservedWords = [
  'ACCESSIBLE',
  'ACTION',
  'AGAINST',
  'AGGREGATE',
  'ALGORITHM',
  'ALL',
  'ALTER',
  'ANALYSE',
  'ANALYZE',
  'AS',
  'ASC',
  'AUTOCOMMIT',
  'AUTO_INCREMENT',
  'BACKUP',
  'BEGIN',
  'BETWEEN',
  'BINLOG',
  'BOTH',
  'CASCADE',
  'CASE',
  'CHANGE',
  'CHANGED',
  'CHARACTER SET',
  'CHARSET',
  'CHECK',
  'CHECKSUM',
  'COLLATE',
  'COLLATION',
  'COLUMN',
  'COLUMNS',
  'COMMENT',
  'COMMIT',
  'COMMITTED',
  'COMPRESSED',
  'CONCURRENT',
  'CONSTRAINT',
  'CONTAINS',
  'CONVERT',
  'CREATE',
  'CROSS',
  'CURRENT_TIMESTAMP',
  'DATABASE',
  'DATABASES',
  'DAY',
  'DAY_HOUR',
  'DAY_MINUTE',
  'DAY_SECOND',
  'DEFAULT',
  'DEFINER',
  'DELAYED',
  'DELETE',
  'DESC',
  'DESCRIBE',
  'DETERMINISTIC',
  'DISTINCT',
  'DISTINCTROW',
  'DIV',
  'DO',
  'DROP',
  'DUMPFILE',
  'DUPLICATE',
  'DYNAMIC',
  'ELSE',
  'ENCLOSED',
  'END',
  'ENGINE',
  'ENGINES',
  'ENGINE_TYPE',
  'ESCAPE',
  'ESCAPED',
  'EVENTS',
  'EXEC',
  'EXECUTE',
  'EXISTS',
  'EXPLAIN',
  'EXTENDED',
  'FAST',
  'FETCH',
  'FIELDS',
  'FILE',
  'FIRST',
  'FIXED',
  'FLUSH',
  'FOR',
  'FORCE',
  'FOREIGN',
  'FULL',
  'FULLTEXT',
  'FUNCTION',
  'GLOBAL',
  'GRANT',
  'GRANTS',
  'GROUP_CONCAT',
  'HEAP',
  'HIGH_PRIORITY',
  'HOSTS',
  'HOUR',
  'HOUR_MINUTE',
  'HOUR_SECOND',
  'IDENTIFIED',
  'IF',
  'IFNULL',
  'IGNORE',
  'IN',
  'INDEX',
  'INDEXES',
  'INFILE',
  'INSERT',
  'INSERT_ID',
  'INSERT_METHOD',
  'INTERVAL',
  'INTO',
  'INVOKER',
  'IS',
  'ISOLATION',
  'KEY',
  'KEYS',
  'KILL',
  'LAST_INSERT_ID',
  'LEADING',
  'LEVEL',
  'LIKE',
  'LINEAR',
  'LINES',
  'LOAD',
  'LOCAL',
  'LOCK',
  'LOCKS',
  'LOGS',
  'LOW_PRIORITY',
  'MARIA',
  'MASTER',
  'MASTER_CONNECT_RETRY',
  'MASTER_HOST',
  'MASTER_LOG_FILE',
  'MATCH',
  'MAX_CONNECTIONS_PER_HOUR',
  'MAX_QUERIES_PER_HOUR',
  'MAX_ROWS',
  'MAX_UPDATES_PER_HOUR',
  'MAX_USER_CONNECTIONS',
  'MEDIUM',
  'MERGE',
  'MINUTE',
  'MINUTE_SECOND',
  'MIN_ROWS',
  'MODE',
  'MODIFY',
  'MONTH',
  'MRG_MYISAM',
  'MYISAM',
  'NAMES',
  'NATURAL',
  'NOT',
  'NOW()',
  'NULL',
  'OFFSET',
  'ON DELETE',
  'ON UPDATE',
  'ON',
  'ONLY',
  'OPEN',
  'OPTIMIZE',
  'OPTION',
  'OPTIONALLY',
  'OUTFILE',
  'PACK_KEYS',
  'PAGE',
  'PARTIAL',
  'PARTITION',
  'PARTITIONS',
  'PASSWORD',
  'PRIMARY',
  'PRIVILEGES',
  'PROCEDURE',
  'PROCESS',
  'PROCESSLIST',
  'PURGE',
  'QUICK',
  'RAID0',
  'RAID_CHUNKS',
  'RAID_CHUNKSIZE',
  'RAID_TYPE',
  'RANGE',
  'READ',
  'READ_ONLY',
  'READ_WRITE',
  'REFERENCES',
  'REGEXP',
  'RELOAD',
  'RENAME',
  'REPAIR',
  'REPEATABLE',
  'REPLACE',
  'REPLICATION',
  'RESET',
  'RESTORE',
  'RESTRICT',
  'RETURN',
  'RETURNS',
  'REVOKE',
  'RLIKE',
  'ROLLBACK',
  'ROW',
  'ROWS',
  'ROW_FORMAT',
  'SECOND',
  'SECURITY',
  'SEPARATOR',
  'SERIALIZABLE',
  'SESSION',
  'SHARE',
  'SHOW',
  'SHUTDOWN',
  'SLAVE',
  'SONAME',
  'SOUNDS',
  'SQL',
  'SQL_AUTO_IS_NULL',
  'SQL_BIG_RESULT',
  'SQL_BIG_SELECTS',
  'SQL_BIG_TABLES',
  'SQL_BUFFER_RESULT',
  'SQL_CACHE',
  'SQL_CALC_FOUND_ROWS',
  'SQL_LOG_BIN',
  'SQL_LOG_OFF',
  'SQL_LOG_UPDATE',
  'SQL_LOW_PRIORITY_UPDATES',
  'SQL_MAX_JOIN_SIZE',
  'SQL_NO_CACHE',
  'SQL_QUOTE_SHOW_CREATE',
  'SQL_SAFE_UPDATES',
  'SQL_SELECT_LIMIT',
  'SQL_SLAVE_SKIP_COUNTER',
  'SQL_SMALL_RESULT',
  'SQL_WARNINGS',
  'START',
  'STARTING',
  'STATUS',
  'STOP',
  'STORAGE',
  'STRAIGHT_JOIN',
  'STRING',
  'STRIPED',
  'SUPER',
  'TABLE',
  'TABLES',
  'TEMPORARY',
  'TERMINATED',
  'THEN',
  'TO',
  'TRAILING',
  'TRANSACTIONAL',
  'TRUE',
  'TRUNCATE',
  'TYPE',
  'TYPES',
  'UNCOMMITTED',
  'UNIQUE',
  'UNLOCK',
  'UNSIGNED',
  'USAGE',
  'USE',
  'USING',
  'VARIABLES',
  'VIEW',
  'WHEN',
  'WITH',
  'WORK',
  'WRITE',
  'YEAR_MONTH'
];

const reservedTopLevelWords = [
  'ADD',
  'AFTER',
  'ALTER COLUMN',
  'ALTER TABLE',
  'DELETE FROM',
  'EXCEPT',
  'FETCH FIRST',
  'FROM',
  'GROUP BY',
  'GO',
  'HAVING',
  'INSERT INTO',
  'INSERT',
  'LIMIT',
  'MODIFY',
  'ORDER BY',
  'SELECT',
  'SET CURRENT SCHEMA',
  'SET SCHEMA',
  'SET',
  'UPDATE',
  'VALUES',
  'WHERE'
];

const reservedTopLevelWordsNoIndent = ['INTERSECT', 'INTERSECT ALL', 'MINUS', 'UNION', 'UNION ALL'];

const reservedNewlineWords = [
  'AND',
  'CROSS APPLY',
  'CROSS JOIN',
  'ELSE',
  'INNER JOIN',
  'JOIN',
  'LEFT JOIN',
  'LEFT OUTER JOIN',
  'OR',
  'OUTER APPLY',
  'OUTER JOIN',
  'RIGHT JOIN',
  'RIGHT OUTER JOIN',
  'WHEN',
  'XOR'
];

let tokenizer;

class StandardSqlFormatter {
  /**
   * @param {Object} cfg Different set of configurations
   */
  constructor(cfg) {
    this.cfg = cfg;
  }

  /**
   * Format the whitespace in a Standard SQL string to make it easier to read
   *
   * @param {String} query The Standard SQL string
   * @return {String} formatted string
   */
  format(query) {
    if (!tokenizer) {
      tokenizer = new Tokenizer({
        reservedWords,
        reservedTopLevelWords,
        reservedNewlineWords,
        reservedTopLevelWordsNoIndent,
        stringTypes: [`""`, "N''", "''", '``', '[]'],
        openParens: ['(', 'CASE'],
        closeParens: [')', 'END'],
        indexedPlaceholderTypes: ['?'],
        namedPlaceholderTypes: ['@', ':'],
        lineCommentTypes: ['#', '--']
      });
    }
    return new Formatter(this.cfg, tokenizer).format(query);
  }
}

/**
 * Format whitespace in a query to make it easier to read.
 *
 * @param {String} query
 * @param {Object} cfg
 *  @param {String} cfg.language Query language, default is Standard SQL
 *  @param {String} cfg.indent Characters used for indentation, default is "  " (2 spaces)
 *  @param {Bool} cfg.uppercase Converts keywords to uppercase
 *  @param {Integer} cfg.linesBetweenQueries How many line breaks between queries
 *  @param {Object} cfg.params Collection of params for placeholder replacement
 * @return {String}
 */
const format = (query, cfg = {}) => {
  switch (cfg.language) {
    case 'db2':
      return new Db2Formatter(cfg).format(query);
    case 'n1ql':
      return new N1qlFormatter(cfg).format(query);
    case 'pl/sql':
      return new PlSqlFormatter(cfg).format(query);
    case 'sql':
    case undefined:
      return new StandardSqlFormatter(cfg).format(query);
    default:
      throw Error(`Unsupported SQL dialect: ${cfg.language}`);
  }
};

exports.format = format;
