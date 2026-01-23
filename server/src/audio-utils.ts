/**
 * Audio Processing Utilities
 *
 * Functions for audio format conversion needed for phone calls:
 * - Resampling: Convert 24kHz TTS audio to 8kHz phone audio
 * - Encoding: Convert PCM to mu-law (G.711) for PSTN compatibility
 */

/**
 * Resample 24kHz PCM audio to 8kHz using linear interpolation
 * Acts as a simple anti-aliasing low-pass filter
 *
 * @param pcmData - 16-bit PCM audio at 24kHz
 * @returns 16-bit PCM audio at 8kHz
 */
export function resample24kTo8k(pcmData: Buffer): Buffer {
  const inputSamples = pcmData.length / 2;
  const outputSamples = Math.floor(inputSamples / 3);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    // Use linear interpolation instead of point-sampling to reduce artifacts
    // For each output sample, average the 3 surrounding input samples
    // This acts as a simple anti-aliasing low-pass filter
    const baseIdx = i * 3;
    const s0 = pcmData.readInt16LE(baseIdx * 2);
    const s1 = baseIdx + 1 < inputSamples ? pcmData.readInt16LE((baseIdx + 1) * 2) : s0;
    const s2 = baseIdx + 2 < inputSamples ? pcmData.readInt16LE((baseIdx + 2) * 2) : s1;
    const interpolated = Math.round((s0 + s1 + s2) / 3);
    output.writeInt16LE(interpolated, i * 2);
  }

  return output;
}

/**
 * Convert a single PCM sample to mu-law encoding
 *
 * @param pcm - 16-bit signed PCM sample
 * @returns 8-bit mu-law encoded sample
 */
export function pcmToMuLawSample(pcm: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (pcm >> 8) & 0x80;
  if (sign) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--) {
    expMask >>= 1;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

/**
 * Convert PCM audio buffer to mu-law encoding
 *
 * @param pcmData - 16-bit PCM audio buffer
 * @returns 8-bit mu-law encoded audio buffer
 */
export function pcmToMuLaw(pcmData: Buffer): Buffer {
  const muLawData = Buffer.alloc(Math.floor(pcmData.length / 2));
  for (let i = 0; i < muLawData.length; i++) {
    const pcm = pcmData.readInt16LE(i * 2);
    muLawData[i] = pcmToMuLawSample(pcm);
  }
  return muLawData;
}

/**
 * Convert mu-law encoded sample back to PCM (for testing/verification)
 *
 * @param muLaw - 8-bit mu-law encoded sample
 * @returns 16-bit signed PCM sample
 */
export function muLawToPcmSample(muLaw: number): number {
  const BIAS = 0x84;

  // Complement to restore original value
  muLaw = ~muLaw & 0xff;

  const sign = muLaw & 0x80;
  const exponent = (muLaw >> 4) & 0x07;
  const mantissa = muLaw & 0x0f;

  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;

  return sign ? -sample : sample;
}

/**
 * Convert mu-law audio buffer to PCM (for testing/verification)
 *
 * @param muLawData - 8-bit mu-law encoded audio buffer
 * @returns 16-bit PCM audio buffer
 */
export function muLawToPcm(muLawData: Buffer): Buffer {
  const pcmData = Buffer.alloc(muLawData.length * 2);
  for (let i = 0; i < muLawData.length; i++) {
    const pcm = muLawToPcmSample(muLawData[i]);
    pcmData.writeInt16LE(pcm, i * 2);
  }
  return pcmData;
}
