// Stand-in for node:net in the browser bundle: Scam Finder only asks whether a host is an IP address
const V4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const isIPv4 = (host) => V4.test(String(host));
const isIPv6 = (host) => /^[0-9a-f:.]+$/i.test(String(host)) && String(host).includes(':');
const isIP = (host) => (isIPv4(host) ? 4 : isIPv6(host) ? 6 : 0);
export default { isIP, isIPv4, isIPv6 };
export { isIP, isIPv4, isIPv6 };
