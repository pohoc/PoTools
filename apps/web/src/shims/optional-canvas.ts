/** Browser builds do not use the Node canvas implementation. */
export const createCanvas = () => {
  throw new Error('Native canvas is unavailable in the browser preview bundle.');
};
export default {};
