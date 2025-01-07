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

import {
  createWorketFromSrc,
  registeredWorklets,
} from "./audioworklet-registry";

export class AudioStreamer {
  public audioQueue: Float32Array[] = [];
  private isPlaying: boolean = false;
  private sampleRate: number = 24000;
  private bufferSize: number = 7680;
  private processingBuffer: Float32Array = new Float32Array(0);
  private scheduledTime: number = 0;
  public gainNode: GainNode;
  private isStreamComplete: boolean = false;
  private checkInterval: number | null = null;
  private initialBufferTime: number = 0.1;
  private endOfQueueAudioSource: AudioBufferSourceNode | null = null;
  private silenceSource: OscillatorNode | null = null;
  private isIOS: boolean;
  private initialized: boolean = false;
  private worklets: Map<string, AudioWorkletNode> = new Map();

  public onComplete = () => {};

  constructor(public context: AudioContext) {
    // More robust iOS detection
    const isIOS = [
      'iPad Simulator',
      'iPhone Simulator',
      'iPod Simulator',
      'iPad',
      'iPhone',
      'iPod',
    ].includes(navigator.platform)
    // iPad on iOS 13 detection
    || (navigator.userAgent.includes("Mac") && "ontouchend" in document);
    
    this.isIOS = isIOS;

    this.gainNode = this.context.createGain();
    this.gainNode.gain.value = 0; // Start muted
    this.gainNode.connect(this.context.destination);
    this.addPCM16 = this.addPCM16.bind(this);

    // Always try to resume the context in constructor
    this.context.resume().catch(err => {
      console.warn("Error resuming context:", err);
    });
  }

  async addWorklet<T extends (d: any) => void>(
    workletName: string,
    workletSrc: string,
    handler: T,
  ): Promise<this> {
    await this.ensureAudioContextRunning();

    try {
      if (this.worklets.has(workletName)) {
        const worklet = this.worklets.get(workletName)!;
        worklet.port.onmessage = (ev: MessageEvent) => handler.call(worklet.port, ev);
        return this;
      }

      const src = createWorketFromSrc(workletName, workletSrc);
      await this.context.audioWorklet.addModule(src);
      
      const worklet = new AudioWorkletNode(this.context, workletName, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: {
          sampleRate: this.sampleRate,
        }
      });

      worklet.port.onmessage = (ev: MessageEvent) => handler.call(worklet.port, ev);
      worklet.connect(this.context.destination);
      this.worklets.set(workletName, worklet);

      return this;
    } catch (error) {
      console.warn('Failed to add audio worklet:', error);
      throw error;
    }
  }

  private async initialize() {
    if (this.initialized) return;
    
    try {
      await this.context.resume();
      
      if (this.isIOS) {
        await this.initializeSilentAudio();
      }
      
      // For iOS, we need to wait for a user gesture to set the gain
      if (this.isIOS) {
        this.gainNode.gain.value = 0;
      } else {
        this.gainNode.gain.setValueAtTime(1, this.context.currentTime);
      }
      
      this.initialized = true;
    } catch (error) {
      console.warn('Failed to initialize audio:', error);
      throw error;
    }
  }

  private async initializeSilentAudio() {
    try {
      this.silenceSource = this.context.createOscillator();
      const silenceGain = this.context.createGain();
      silenceGain.gain.value = 0.0001;
      this.silenceSource.connect(silenceGain);
      silenceGain.connect(this.context.destination);
      
      const buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      
      this.silenceSource.start();
      source.start(0);
    } catch (error) {
      console.warn('Failed to initialize silent audio:', error);
      throw error;
    }
  }

  private async ensureAudioContextRunning() {
    if (!this.initialized) {
      await this.initialize();
    }
    if (this.context.state !== "running") {
      await this.context.resume();
    }
  }

  async addPCM16(chunk: Uint8Array) {
    await this.ensureAudioContextRunning();

    const float32Array = new Float32Array(chunk.length / 2);
    const dataView = new DataView(chunk.buffer);

    for (let i = 0; i < chunk.length / 2; i++) {
      try {
        const int16 = dataView.getInt16(i * 2, true);
        float32Array[i] = int16 / 32768;
      } catch (e) {
        console.error('Error processing PCM data:', e);
      }
    }

    const newBuffer = new Float32Array(
      this.processingBuffer.length + float32Array.length,
    );
    newBuffer.set(this.processingBuffer);
    newBuffer.set(float32Array, this.processingBuffer.length);
    this.processingBuffer = newBuffer;

    while (this.processingBuffer.length >= this.bufferSize) {
      const buffer = this.processingBuffer.slice(0, this.bufferSize);
      this.audioQueue.push(buffer);
      this.processingBuffer = this.processingBuffer.slice(this.bufferSize);
    }

    if (!this.isPlaying) {
      this.isPlaying = true;
      this.scheduledTime = this.context.currentTime + this.initialBufferTime;
      await this.scheduleNextBuffer();
    }
  }

  private createAudioBuffer(audioData: Float32Array): AudioBuffer {
    const audioBuffer = this.context.createBuffer(
      1,
      audioData.length,
      this.sampleRate,
    );
    audioBuffer.getChannelData(0).set(audioData);
    return audioBuffer;
  }

  private async scheduleNextBuffer() {
    await this.ensureAudioContextRunning();

    const SCHEDULE_AHEAD_TIME = 0.2;

    while (
      this.audioQueue.length > 0 &&
      this.scheduledTime < this.context.currentTime + SCHEDULE_AHEAD_TIME
    ) {
      const audioData = this.audioQueue.shift()!;
      const audioBuffer = this.createAudioBuffer(audioData);
      const source = this.context.createBufferSource();

      if (this.audioQueue.length === 0) {
        if (this.endOfQueueAudioSource) {
          this.endOfQueueAudioSource.onended = null;
        }
        this.endOfQueueAudioSource = source;
        source.onended = () => {
          if (!this.audioQueue.length && this.endOfQueueAudioSource === source) {
            this.endOfQueueAudioSource = null;
            this.onComplete();
          }
        };
      }

      source.buffer = audioBuffer;
      source.connect(this.gainNode);

      for (const worklet of this.worklets.values()) {
        source.connect(worklet);
      }

      const startTime = Math.max(this.scheduledTime, this.context.currentTime);
      source.start(startTime);
      this.scheduledTime = startTime + audioBuffer.duration;
    }

    if (this.audioQueue.length === 0 && this.processingBuffer.length === 0) {
      if (this.isStreamComplete) {
        this.isPlaying = false;
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
      } else {
        if (!this.checkInterval) {
          this.checkInterval = window.setInterval(() => {
            if (
              this.audioQueue.length > 0 ||
              this.processingBuffer.length >= this.bufferSize
            ) {
              this.scheduleNextBuffer();
            }
          }, 100) as unknown as number;
        }
      }
    } else {
      const nextCheckTime =
        (this.scheduledTime - this.context.currentTime) * 1000;
      setTimeout(
        () => this.scheduleNextBuffer(),
        Math.max(0, nextCheckTime - 50),
      );
    }
  }

  async resume() {
    await this.ensureAudioContextRunning();
    
    if (this.isIOS) {
      const buffer = this.context.createBuffer(1, 1, 44100);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      source.start(0);
      
      const currentTime = this.context.currentTime;
      this.gainNode.gain.cancelScheduledValues(currentTime);
      this.gainNode.gain.setValueAtTime(0, currentTime);
      this.gainNode.gain.linearRampToValueAtTime(1, currentTime + 0.1);
    } else {
      this.gainNode.gain.setValueAtTime(1, this.context.currentTime);
    }
    
    this.isStreamComplete = false;
    this.scheduledTime = this.context.currentTime + this.initialBufferTime;
  }

  async stop() {
    this.isPlaying = false;
    this.isStreamComplete = true;
    this.audioQueue = [];
    this.processingBuffer = new Float32Array(0);
    this.scheduledTime = this.context.currentTime;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.silenceSource) {
      this.silenceSource.stop();
      this.silenceSource.disconnect();
      this.silenceSource = null;
    }

    for (const worklet of this.worklets.values()) {
      worklet.disconnect();
    }
    this.worklets.clear();

    const currentTime = this.context.currentTime;
    this.gainNode.gain.cancelScheduledValues(currentTime);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, currentTime);
    this.gainNode.gain.linearRampToValueAtTime(0, currentTime + 0.1);

    setTimeout(() => {
      this.gainNode.disconnect();
      this.gainNode = this.context.createGain();
      this.gainNode.connect(this.context.destination);
    }, 200);
  }

  complete() {
    this.isStreamComplete = true;
    if (this.processingBuffer.length > 0) {
      this.audioQueue.push(this.processingBuffer);
      this.processingBuffer = new Float32Array(0);
      if (this.isPlaying) {
        this.scheduleNextBuffer();
      }
    } else {
      this.onComplete();
    }
  }
}

// // Usage example:
// const audioStreamer = new AudioStreamer();
//
// // In your streaming code:
// function handleChunk(chunk: Uint8Array) {
//   audioStreamer.handleChunk(chunk);
// }
//
// // To start playing (call this in response to a user interaction)
// await audioStreamer.resume();
//
// // To stop playing
// // audioStreamer.stop();
