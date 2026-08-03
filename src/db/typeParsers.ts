import { types } from 'pg';

// pg returns bigint/int8 columns (torbox_id, size, bigserial ids) as strings
// by default, since JS numbers can't safely represent the full 64-bit range.
// Every bigint column in this schema holds a "normal sized" number (a row id,
// a torbox id, a byte count) that will never approach Number.MAX_SAFE_INTEGER
// (~9 * 10^15 -- an 9-petabyte file, or 9 quadrillion rows), so parsing them
// as JS numbers trades an unreachable ceiling for not having to thread
// BigInt/string handling through every size comparison and sort in the app.
const PG_INT8_OID = 20;
types.setTypeParser(PG_INT8_OID, (val: string) => parseInt(val, 10));
