const os = require('node:os');
const net = require('node:net');
const dns = require('node:dns/promises');

async function onServerSubnet(lanUrl, interfaces = os.networkInterfaces()) {
  const host = new URL(lanUrl).hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host }];
  } else {
    let timer;
    try {
      addresses = await Promise.race([
        dns.lookup(host, { all: true }),
        new Promise(resolve => { timer = setTimeout(() => resolve([]), 1500); }),
      ]);
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  const networks = new net.BlockList();
  for (const nic of Object.values(interfaces).flat()) {
    if (!nic || nic.internal || !nic.cidr) continue;
    const prefix = Number(nic.cidr.split('/')[1]);
    if (prefix > 0) networks.addSubnet(nic.address.split('%')[0], prefix, net.isIPv4(nic.address) ? 'ipv4' : 'ipv6');
  }
  return addresses.some(({ address }) => networks.check(address, net.isIPv4(address) ? 'ipv4' : 'ipv6'));
}

async function fetchCheckUpdate(base, timeout, localOnly = false) {
  try {
    let url = new URL(base.replace(/\/$/, '') + '/check_update');
    const origin = url.origin;
    const signal = AbortSignal.timeout(timeout);
    for (let n = 0; n < 5; n++) {
      const res = await fetch(url, { signal, redirect: 'manual' });
      if (res.status === 200) {
        const data = await res.json();
        if (typeof data?.version !== 'string' || !data.version.trim()) return { ok: false, reason: 'missing version' };
        return { ok: true, version: data.version, fileName: data.fileName, downloadUrl: data.downloadUrl, releaseNotes: data.releaseNotes };
      }
      await res.body?.cancel();
      const location = res.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) return { ok: false, reason: 'HTTP ' + res.status };
      url = new URL(location, url);
      if (localOnly && url.origin !== origin) return { ok: false, reason: '局域网地址返回了跨站重定向' };
    }
    return { ok: false, reason: 'too many redirects' };
  } catch (err) { return { ok: false, reason: err.cause?.code || err.message }; }
}

function normalizeBase(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href.replace(/\/$/, '') : '';
  } catch { return ''; }
}

async function selectServer(config, local, probe, interfaces = os.networkInterfaces()) {
  const lan = normalizeBase(config.lanBaseUrl);
  const pub = normalizeBase(config.publicBaseUrl);
  // A routed office network or VPN can reach the LAN server even across subnets.
  if (lan && await probe(lan, true)) return { base: lan, localOnly: true };
  const internal = !!lan && await onServerSubnet(lan, interfaces);
  if (!internal && pub && pub !== lan && await probe(pub, false)) return { base: pub, localOnly: false };
  if (local !== lan && await probe(local, true)) return { base: local, localOnly: true };
  return { base: null, localOnly: internal };
}

function updatePackageUrl(base, info, localOnly) {
  if (!info.downloadUrl) return null;
  if (info.fileName) return base.replace(/\/$/, '') + '/releases/' + encodeURIComponent(info.fileName);
  // Older manifests can contain an absolute public URL without a separate file name.
  const url = new URL(info.downloadUrl, base);
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  return localOnly ? new URL(base).origin + url.pathname + url.search : url.href;
}

module.exports = { selectServer, fetchCheckUpdate, updatePackageUrl };
