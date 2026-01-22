/**
 * Token encoding/decoding for SDK resume functionality
 *
 * Re-exports from the main token module for consistency
 */

import { encodeToken as mainEncode, decodeToken as mainDecode } from '../token.js';

export const encodeToken = mainEncode;
export const decodeToken = mainDecode;
