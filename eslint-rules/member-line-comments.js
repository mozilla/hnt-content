/**
 * Require `//` comments on interface and type-literal members. Members carry
 * short notes, and JSDoc blocks stay reserved for functions and declarations.
 * Trade-off: unlike JSDoc, `//` notes do not show in IDE hover.
 */
export default {
  meta: {
    type: 'layout',
    docs: {
      description:
        'Require `//` line comments instead of block comments on interface and type-literal members',
    },
    fixable: 'code',
    messages: {
      useLineComment:
        'Use `//` line comments on interface and type members, not `/* */` blocks.',
    },
  },
  create(context) {
    const { sourceCode } = context;

    /** Rewrite a block comment as `//` lines aligned to its start column. */
    function toLineComments(comment) {
      const indent = ' '.repeat(comment.loc.start.column);
      return comment.value
        .split('\n')
        .map((line) => line.replace(/^\s*\*? ?/, '').trimEnd())
        .join('\n')
        .trim()
        .split('\n')
        .map((line) => (line === '' ? '//' : `// ${line}`))
        .join(`\n${indent}`);
    }

    /** Report block comments that lead any member in the list. */
    function checkMembers(members) {
      for (const member of members) {
        const blocks = sourceCode
          .getCommentsBefore(member)
          .filter((comment) => comment.type === 'Block');
        for (const comment of blocks) {
          context.report({
            loc: comment.loc,
            messageId: 'useLineComment',
            // A block on the same line as its member cannot become a line
            // comment without swallowing the member, so leave that to a human.
            fix:
              comment.loc.end.line < member.loc.start.line
                ? (fixer) => fixer.replaceText(comment, toLineComments(comment))
                : null,
          });
        }
      }
    }

    return {
      TSInterfaceBody(node) {
        checkMembers(node.body);
      },
      TSTypeLiteral(node) {
        checkMembers(node.members);
      },
    };
  },
};
