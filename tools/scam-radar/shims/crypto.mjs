// Stand-in for node:crypto in the browser bundle. The offline heuristics never hash anything;
// the page hashes names itself with the Web Crypto API.
const createHash = () => {
  throw new Error('Hashing is not part of the browser bundle');
};
export default { createHash };
export { createHash };
