const { randomBytes, scrypt, scryptSync, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 32);
  return salt + ':' + key.toString('hex');
}

// Authenticated password resets are rare and run within the existing synchronous user-file update.
function resetPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 32).toString('hex');
}

async function verifyPassword(password, stored) {
  if (!/^[a-f0-9]{32}:[a-f0-9]{64}$/.test(stored)) return false;
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(await derive(password, salt, 32), Buffer.from(hash, 'hex'));
}

module.exports = { hashPassword, resetPassword, verifyPassword };
