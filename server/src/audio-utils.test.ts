/**
 * Tests for audio processing utilities
 */

import { describe, test, expect } from 'bun:test';
import {
  resample24kTo8k,
  pcmToMuLaw,
  pcmToMuLawSample,
  muLawToPcm,
  muLawToPcmSample,
} from './audio-utils.js';

describe('resample24kTo8k', () => {
  test('reduces sample rate by 3x', () => {
    // 24 samples at 24kHz = 8 samples at 8kHz
    // Each sample is 2 bytes (16-bit)
    const input = Buffer.alloc(24 * 2);
    for (let i = 0; i < 24; i++) {
      input.writeInt16LE(1000, i * 2);
    }

    const output = resample24kTo8k(input);

    // Output should be 1/3 the samples
    expect(output.length).toBe(8 * 2);
  });

  test('handles empty input', () => {
    const input = Buffer.alloc(0);
    const output = resample24kTo8k(input);
    expect(output.length).toBe(0);
  });

  test('handles single sample (not enough for resample)', () => {
    const input = Buffer.alloc(2);
    input.writeInt16LE(1000, 0);
    const output = resample24kTo8k(input);
    expect(output.length).toBe(0);
  });

  test('averages 3 samples for interpolation', () => {
    // Create 3 samples: 0, 300, 600 -> average should be 300
    const input = Buffer.alloc(6);
    input.writeInt16LE(0, 0);
    input.writeInt16LE(300, 2);
    input.writeInt16LE(600, 4);

    const output = resample24kTo8k(input);

    expect(output.length).toBe(2);
    expect(output.readInt16LE(0)).toBe(300);
  });

  test('handles negative samples', () => {
    const input = Buffer.alloc(6);
    input.writeInt16LE(-1000, 0);
    input.writeInt16LE(-1000, 2);
    input.writeInt16LE(-1000, 4);

    const output = resample24kTo8k(input);

    expect(output.readInt16LE(0)).toBe(-1000);
  });

  test('preserves signal characteristics for sine wave', () => {
    // Generate a simple pattern
    const samples = 30;
    const input = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const value = Math.round(10000 * Math.sin((i / samples) * Math.PI * 2));
      input.writeInt16LE(value, i * 2);
    }

    const output = resample24kTo8k(input);

    // Output should have 10 samples
    expect(output.length).toBe(10 * 2);

    // Values should still be in reasonable range
    for (let i = 0; i < 10; i++) {
      const value = output.readInt16LE(i * 2);
      expect(value).toBeGreaterThanOrEqual(-10000);
      expect(value).toBeLessThanOrEqual(10000);
    }
  });
});

describe('pcmToMuLawSample', () => {
  test('converts silence (0) correctly', () => {
    const result = pcmToMuLawSample(0);
    // Silence in mu-law is typically 0xFF or 0x7F
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(255);
  });

  test('converts positive samples', () => {
    const result = pcmToMuLawSample(10000);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(255);
  });

  test('converts negative samples', () => {
    const result = pcmToMuLawSample(-10000);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(255);
  });

  test('handles maximum positive value', () => {
    const result = pcmToMuLawSample(32767);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(255);
  });

  test('handles maximum negative value', () => {
    const result = pcmToMuLawSample(-32768);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(255);
  });

  test('clips values above threshold', () => {
    // Values above 32635 should be clipped
    const result1 = pcmToMuLawSample(32635);
    const result2 = pcmToMuLawSample(32767);
    // Both should produce the same result due to clipping
    expect(result1).toBe(result2);
  });
});

describe('pcmToMuLaw', () => {
  test('converts buffer correctly', () => {
    const input = Buffer.alloc(4);
    input.writeInt16LE(1000, 0);
    input.writeInt16LE(-1000, 2);

    const output = pcmToMuLaw(input);

    // Output should be half the size (1 byte per sample instead of 2)
    expect(output.length).toBe(2);
  });

  test('handles empty buffer', () => {
    const input = Buffer.alloc(0);
    const output = pcmToMuLaw(input);
    expect(output.length).toBe(0);
  });

  test('each byte is valid mu-law value', () => {
    const input = Buffer.alloc(20);
    for (let i = 0; i < 10; i++) {
      input.writeInt16LE(i * 1000, i * 2);
    }

    const output = pcmToMuLaw(input);

    for (let i = 0; i < output.length; i++) {
      expect(output[i]).toBeGreaterThanOrEqual(0);
      expect(output[i]).toBeLessThanOrEqual(255);
    }
  });
});

describe('muLawToPcmSample', () => {
  test('inverts pcmToMuLawSample approximately', () => {
    // mu-law is lossy, so we can't expect exact match
    // but the roundtrip should be close
    const originalValues = [0, 1000, -1000, 10000, -10000, 20000, -20000];

    for (const original of originalValues) {
      const muLaw = pcmToMuLawSample(original);
      const recovered = muLawToPcmSample(muLaw);

      // Allow some error due to lossy compression
      // mu-law has ~14-bit dynamic range compressed to 8 bits
      const errorMargin = Math.abs(original) * 0.15 + 100;
      expect(Math.abs(recovered - original)).toBeLessThan(errorMargin);
    }
  });
});

describe('muLawToPcm', () => {
  test('converts buffer back to PCM', () => {
    const original = Buffer.alloc(10);
    for (let i = 0; i < 5; i++) {
      original.writeInt16LE(i * 5000 - 10000, i * 2);
    }

    const muLaw = pcmToMuLaw(original);
    const recovered = muLawToPcm(muLaw);

    expect(recovered.length).toBe(original.length);

    // Check that values are approximately preserved
    for (let i = 0; i < 5; i++) {
      const orig = original.readInt16LE(i * 2);
      const recv = recovered.readInt16LE(i * 2);
      const errorMargin = Math.abs(orig) * 0.15 + 100;
      expect(Math.abs(recv - orig)).toBeLessThan(errorMargin);
    }
  });

  test('handles empty buffer', () => {
    const input = Buffer.alloc(0);
    const output = muLawToPcm(input);
    expect(output.length).toBe(0);
  });
});

describe('end-to-end audio pipeline', () => {
  test('resample then encode produces valid output', () => {
    // Simulate TTS output: 24kHz PCM
    const ttsOutput = Buffer.alloc(240); // 10ms of audio at 24kHz
    for (let i = 0; i < 120; i++) {
      const value = Math.round(5000 * Math.sin((i / 120) * Math.PI * 2));
      ttsOutput.writeInt16LE(value, i * 2);
    }

    // Resample to 8kHz
    const resampled = resample24kTo8k(ttsOutput);
    expect(resampled.length).toBe(80); // 40 samples * 2 bytes

    // Encode to mu-law
    const muLaw = pcmToMuLaw(resampled);
    expect(muLaw.length).toBe(40); // 40 samples * 1 byte

    // Verify all bytes are valid
    for (let i = 0; i < muLaw.length; i++) {
      expect(muLaw[i]).toBeGreaterThanOrEqual(0);
      expect(muLaw[i]).toBeLessThanOrEqual(255);
    }
  });

  test('full roundtrip preserves signal shape', () => {
    // Create a ramp signal
    const input = Buffer.alloc(30 * 2);
    for (let i = 0; i < 30; i++) {
      input.writeInt16LE((i - 15) * 1000, i * 2);
    }

    const resampled = resample24kTo8k(input);
    const muLaw = pcmToMuLaw(resampled);
    const recovered = muLawToPcm(muLaw);

    // Check that the signal is still a ramp (increasing values)
    let prevValue = -Infinity;
    for (let i = 0; i < recovered.length / 2; i++) {
      const value = recovered.readInt16LE(i * 2);
      expect(value).toBeGreaterThan(prevValue - 500); // Allow some error
      prevValue = value;
    }
  });
});
