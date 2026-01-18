import { Buffer } from 'node:buffer';

export function encodeToken(obj) {
  const json = JSON.stringify(obj);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeToken(token) {
  try {
    const json = Buffer.from(String(token), 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch (err) {
    throw new Error('Invalid token');
  }
}
