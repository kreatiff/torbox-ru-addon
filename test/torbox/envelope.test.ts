import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseEnvelope, TorboxApiError } from '../../src/torbox/envelope.js';
import { mylistResponseSchema, singleTorrentResponseSchema } from '../../src/torbox/schemas.js';

describe('parseEnvelope', () => {
  it('throws on success:false instead of returning data:null as if it were empty', () => {
    const authError = { success: false, error: 'BAD_TOKEN', detail: 'invalid api key', data: null };
    expect(() => parseEnvelope(authError, mylistResponseSchema, 'test')).toThrow(TorboxApiError);
  });

  it('throws on a body with no recognisable success flag at all', () => {
    expect(() => parseEnvelope({ unexpected: 'shape' }, mylistResponseSchema, 'test')).toThrow(
      TorboxApiError,
    );
    expect(() => parseEnvelope(null, mylistResponseSchema, 'test')).toThrow(TorboxApiError);
  });

  it('throws (does not silently coerce) when success:true but data fails the schema', () => {
    const wrongShape = { success: true, data: { not: 'an array or a torrent' } };
    expect(() => parseEnvelope(wrongShape, mylistResponseSchema, 'test')).toThrow(TorboxApiError);
  });

  it('parses a success:true array body against the mylist schema', () => {
    const body = {
      success: true,
      data: [
        { id: 111, hash: 'abc', name: 'Some Show', size: 5000, cached_at: '2026-01-01T00:00:00Z' },
      ],
    };
    const data = parseEnvelope(body, mylistResponseSchema, 'test');
    expect(data).toHaveLength(1);
    expect(data[0]?.hash).toBe('abc');
  });

  it('parses a success:true single-object body (the ?id= shape) against the single-torrent schema', () => {
    const body = {
      success: true,
      data: {
        id: 111,
        hash: 'abc',
        name: 'Some Show',
        size: 5000,
        files: [{ id: 1, name: 'a.mp4', size: 100 }],
      },
    };
    const data = parseEnvelope(body, singleTorrentResponseSchema, 'test');
    expect(data.hash).toBe('abc');
    expect(data.files).toHaveLength(1);
  });

  it('passes through an arbitrary caller-supplied schema unchanged', () => {
    const body = { success: true, data: { ok: true } };
    const data = parseEnvelope(body, z.object({ ok: z.boolean() }), 'test');
    expect(data.ok).toBe(true);
  });
});
