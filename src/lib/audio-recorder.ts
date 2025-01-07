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

import { audioContext } from "./utils";
import AudioRecordingWorklet from "./worklets/audio-processing";
import VolMeterWorket from "./worklets/vol-meter";

import { createWorketFromSrc } from "./audioworklet-registry";
import EventEmitter from "eventemitter3";

function arrayBufferToBase64(buffer: ArrayBuffer) {
  var binary = "";
  var bytes = new Uint8Array(buffer);
  var len = bytes.byteLength;
  for (var i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export class AudioRecorder extends EventEmitter {
  stream: MediaStream | undefined;
  audioContext: AudioContext | undefined;
  source: MediaStreamAudioSourceNode | undefined;
  recording: boolean = false;
  recordingWorklet: AudioWorkletNode | undefined;
  vuWorklet: AudioWorkletNode | undefined;

  private starting: Promise<void> | null = null;
  private streamCheckInterval: number | undefined;

  constructor(public sampleRate = 16000) {
    super();
  }

  private async checkStreamHealth() {
    if (this.stream) {
      const tracks = this.stream.getAudioTracks();
      for (const track of tracks) {
        if (!track.enabled || track.muted || !track.readyState || track.readyState === 'ended') {
          console.warn('Audio track is in an invalid state:', {
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState
          });
          // Try to recover the stream
          await this.restartStream();
          break;
        }
      }
    }
  }

  private async restartStream() {
    try {
      // Clean up existing stream
      if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
      }

      // Request new stream
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: this.sampleRate,
          // Safari-specific constraints
          channelCount: { ideal: 1 }
        },
      });

      // Reconnect the stream
      if (this.audioContext && this.source) {
        this.source.disconnect();
        this.source = this.audioContext.createMediaStreamSource(this.stream);
        if (this.recordingWorklet) {
          this.source.connect(this.recordingWorklet);
        }
        if (this.vuWorklet) {
          this.source.connect(this.vuWorklet);
        }
      }
    } catch (error) {
      console.error('Failed to restart audio stream:', error);
      this.emit('error', error);
    }
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Could not request user media");
    }

    this.starting = new Promise(async (resolve, reject) => {
      try {
        // Request audio with specific constraints for better Safari compatibility
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: this.sampleRate,
            // Safari-specific constraints
            channelCount: { ideal: 1 }
          },
        });

        // Add track ended event listeners
        this.stream.getAudioTracks().forEach(track => {
          track.onended = async () => {
            console.warn('Audio track ended, attempting to restart');
            await this.restartStream();
          };
          track.addEventListener('mute', async () => {
            console.warn('Audio track muted, attempting to restart');
            await this.restartStream();
          });
        });

        // Initialize audio context with explicit sample rate
        this.audioContext = await audioContext({ 
          sampleRate: this.sampleRate,
          latencyHint: 'interactive'
        });

        // Ensure context is running
        if (this.audioContext.state !== "running") {
          await this.audioContext.resume();
        }

        this.source = this.audioContext.createMediaStreamSource(this.stream);

        const workletName = "audio-recorder-worklet";
        const src = createWorketFromSrc(workletName, AudioRecordingWorklet);

        await this.audioContext.audioWorklet.addModule(src);
        this.recordingWorklet = new AudioWorkletNode(
          this.audioContext,
          workletName,
          {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
            processorOptions: {
              sampleRate: this.sampleRate,
            }
          }
        );

        this.recordingWorklet.port.onmessage = async (ev: MessageEvent) => {
          const arrayBuffer = ev.data.data.int16arrayBuffer;

          if (arrayBuffer) {
            const arrayBufferString = arrayBufferToBase64(arrayBuffer);
            this.emit("data", arrayBufferString);
          }
        };

        this.recordingWorklet.onprocessorerror = (event) => {
          console.error('AudioWorklet processor error:', event);
          this.emit('error', new Error('Audio processing error'));
        };

        this.source.connect(this.recordingWorklet);

        // vu meter worklet
        const vuWorkletName = "vu-meter";
        await this.audioContext.audioWorklet.addModule(
          createWorketFromSrc(vuWorkletName, VolMeterWorket),
        );
        this.vuWorklet = new AudioWorkletNode(this.audioContext, vuWorkletName, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          processorOptions: {
            sampleRate: this.sampleRate,
          }
        });
        
        this.vuWorklet.port.onmessage = (ev: MessageEvent) => {
          this.emit("volume", ev.data.volume);
        };

        this.source.connect(this.vuWorklet);
        this.recording = true;

        // Start periodic health checks
        this.streamCheckInterval = window.setInterval(() => this.checkStreamHealth(), 1000);

        resolve();
      } catch (error) {
        console.error('Failed to start audio recording:', error);
        reject(error);
      } finally {
        this.starting = null;
      }
    });

    return this.starting;
  }

  async stop() {
    try {
      if (this.streamCheckInterval) {
        clearInterval(this.streamCheckInterval);
        this.streamCheckInterval = undefined;
      }

      if (this.starting) {
        await this.starting;
      }
      
      if (this.source) {
        this.source.disconnect();
      }
      
      if (this.recordingWorklet) {
        this.recordingWorklet.disconnect();
      }
      
      if (this.vuWorklet) {
        this.vuWorklet.disconnect();
      }
      
      if (this.audioContext && this.audioContext.state !== 'closed') {
        await this.audioContext.close();
      }
      
      if (this.stream) {
        this.stream.getTracks().forEach(track => {
          track.stop();
          this.stream?.removeTrack(track);
        });
      }
    } catch (error) {
      console.error('Error stopping audio recorder:', error);
    } finally {
      this.stream = undefined;
      this.recordingWorklet = undefined;
      this.vuWorklet = undefined;
      this.audioContext = undefined;
      this.recording = false;
    }
  }
}
