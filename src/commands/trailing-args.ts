/**
 * effect v4 beta cli quirk (beta.78): the lexer splits argv at the first `--`
 * and hands the trailing operands to the ROOT command's arguments — for
 * nested subcommands they never reach the leaf's positional params (the
 * subcommand recursion gets `trailingOperands: []`), so `oad run -- env`
 * would parse zero argv values. Recover them from the raw argv ourselves;
 * leaf handlers concatenate them after whatever the parser did deliver.
 * Remove once the upstream lexer forwards trailing operands to the leaf.
 */
export const trailingOperands = (argv: ReadonlyArray<string> = process.argv): Array<string> => {
  const separator = argv.indexOf("--");
  return separator === -1 ? [] : argv.slice(separator + 1);
};
