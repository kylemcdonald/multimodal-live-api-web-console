/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export type GetAudioContextOptions = AudioContextOptions & {
  id?: string;
};

const map: Map<string, AudioContext> = new Map();
let hasUserInteraction = false;
let userInteractionPromise: Promise<void>;

export const audioContext: (
  options?: GetAudioContextOptions,
) => Promise<AudioContext> = (() => {
  // Create a promise that resolves on first user interaction
  userInteractionPromise = new Promise((resolve) => {
    const handleUserInteraction = () => {
      hasUserInteraction = true;
      resolve();
      // Clean up listeners after first interaction
      window.removeEventListener("touchstart", handleUserInteraction);
      window.removeEventListener("touchend", handleUserInteraction);
      window.removeEventListener("click", handleUserInteraction);
      window.removeEventListener("pointerdown", handleUserInteraction);
      window.removeEventListener("keydown", handleUserInteraction);
    };

    // Add interaction listeners
    window.addEventListener("touchstart", handleUserInteraction);
    window.addEventListener("touchend", handleUserInteraction);
    window.addEventListener("click", handleUserInteraction);
    window.addEventListener("pointerdown", handleUserInteraction);
    window.addEventListener("keydown", handleUserInteraction);
  });

  // For iOS Safari, we need to unlock audio playback
  const unlockAudioContext = async (ctx: AudioContext) => {
    if (ctx.state === "suspended") {
      try {
        // Create and play a brief silent sound
        const buffer = ctx.createBuffer(1, 1, 44100);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
        
        await ctx.resume();
        
        // Wait a bit to ensure the context is properly unlocked
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      } catch (e) {
        console.warn("Failed to unlock audio context:", e);
      }
    }
    return ctx;
  };

  return async (options?: GetAudioContextOptions) => {
    // Wait for user interaction before proceeding
    await userInteractionPromise;
      
    try {
      if (options?.id && map.has(options.id)) {
        const ctx = map.get(options.id);
        if (ctx) {
          await unlockAudioContext(ctx);
          return ctx;
        }
      }

      // iOS Safari prefers 44100 Hz
      const ctx = new AudioContext({
        ...options,
        sampleRate: options?.sampleRate || 44100,
      });
      
      await unlockAudioContext(ctx);

      if (options?.id) {
        map.set(options.id, ctx);
      }
      return ctx;
    } catch (e) {
      console.warn("Failed to initialize AudioContext:", e);
      throw e;
    }
  };
})();

export const blobToJSON = (blob: Blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result) {
        const json = JSON.parse(reader.result as string);
        resolve(json);
      } else {
        reject("oops");
      }
    };
    reader.readAsText(blob);
  });

export function base64ToArrayBuffer(base64: string) {
  var binaryString = atob(base64);
  var bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}
