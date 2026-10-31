/**
 * OptiPixel - Client-Side Pixel Enhancer & Super-Resolution Upscaler
 * 100% Client-side image enhancement via WebGL shaders & Canvas tiling.
 * Fully optimized for Mobile Chrome & low-memory devices.
 */

(function () {
  'use strict';

  // --- Constants & Defaults ---
  const PRESETS = {
    balanced: { scale: 2, cas: 80, denoise: 25, texture: 65, edge: 60 },
    sharp: { scale: 2, cas: 95, denoise: 15, texture: 85, edge: 75 },
    jpeg: { scale: 2, cas: 70, denoise: 65, texture: 50, edge: 55 },
    lineart: { scale: 2, cas: 100, denoise: 40, texture: 40, edge: 90 },
    custom: null
  };

  // --- Device Profile Detector ---
  class DeviceProfile {
    constructor() {
      this.isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 768;
      this.ramGB = navigator.deviceMemory || (this.isMobile ? 3 : 8);
      this.cpuCores = navigator.hardwareConcurrency || 4;
      this.hasWebGL = false;
      this.maxTextureSize = 2048;
      this.rendererName = 'Canvas 2D';
      
      this.probeWebGL();
      this.calculateSafeTileSize();
    }

    probeWebGL() {
      try {
        const testCanvas = document.createElement('canvas');
        testCanvas.width = 16;
        testCanvas.height = 16;
        const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
        if (gl) {
          this.hasWebGL = true;
          this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          if (ext) {
            this.rendererName = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || 'GPU WebGL';
          } else {
            this.rendererName = 'GPU WebGL';
          }
        }
      } catch (e) {
        this.hasWebGL = false;
      }
    }

    calculateSafeTileSize() {
      // On mobile Chrome or low-RAM devices, use conservative tile sizes to prevent tab OOM crash
      if (this.isMobile || this.ramGB <= 4) {
        this.tileSize = 768;
        this.tileOverlap = 16;
      } else {
        this.tileSize = Math.min(1536, Math.floor(this.maxTextureSize / 2));
        this.tileOverlap = 24;
      }
    }
  }

  // --- WebGL Shader Engine ---
  class WebGLEngine {
    constructor() {
      this.gl = null;
      this.canvas = null;
      this.program = null;
      this.initialized = false;
    }

    init() {
      if (this.initialized) return true;
      try {
        this.canvas = document.createElement('canvas');
        const opts = { alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true };
        this.gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
        if (!this.gl) return false;

        const vsSource = `
          attribute vec2 aPosition;
          attribute vec2 aTexCoord;
          varying vec2 vTexCoord;
          void main() {
            vTexCoord = aTexCoord;
            gl_Position = vec4(aPosition, 0.0, 1.0);
          }
        `;

        const fsSource = `
          precision highp float;
          varying vec2 vTexCoord;
          uniform sampler2D uTexture;
          uniform vec2 uSourceSize;
          uniform vec2 uTargetSize;
          uniform float uSharpness;
          uniform float uDenoise;
          uniform float uTextureClarity;
          uniform float uEdgePreserve;

          // Luminance calculation
          float getLum(vec3 c) {
            return dot(c, vec3(0.299, 0.587, 0.114));
          }

          // Fast Catmull-Rom Bicubic filtering via 4 bilinear texture samples
          vec4 textureBicubic(sampler2D tex, vec2 uv, vec2 size) {
            vec2 invSize = 1.0 / size;
            vec2 coord = uv * size - 0.5;
            vec2 f = fract(coord);
            coord -= f;

            vec2 f2 = f * f;
            vec2 f3 = f2 * f;
            vec2 w0 = -0.5 * f3 + f2 - 0.5 * f;
            vec2 w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
            vec2 w2 = -1.5 * f3 + 2.0 * f2 + 0.5 * f;
            vec2 w3 = 0.5 * f3 - 0.5 * f2;

            vec2 s0 = w0 + w1;
            vec2 s1 = w2 + w3;

            vec2 f0 = w1 / max(w0 + w1, 0.0001);
            vec2 f1 = w3 / max(w2 + w3, 0.0001);

            vec2 t0 = (coord - 0.5 + f0) * invSize;
            vec2 t1 = (coord + 1.5 + f1) * invSize;

            t0 = clamp(t0, 0.0, 1.0);
            t1 = clamp(t1, 0.0, 1.0);

            return (
              texture2D(tex, vec2(t0.x, t0.y)) * (s0.x * s0.y) +
              texture2D(tex, vec2(t1.x, t0.y)) * (s1.x * s0.y) +
              texture2D(tex, vec2(t0.x, t1.y)) * (s0.x * s1.y) +
              texture2D(tex, vec2(t1.x, t1.y)) * (s1.x * s1.y)
            );
          }

          void main() {
            // Source resolution step (true physical pixel distance)
            vec2 srcStep = 1.0 / uSourceSize;

            // Center sample via high quality bicubic
            vec4 centerSample = textureBicubic(uTexture, vTexCoord, uSourceSize);
            vec3 c = centerSample.rgb;
            float lumC = getLum(c);

            // Sample 8 surrounding neighbors in SOURCE space
            vec3 tc = textureBicubic(uTexture, clamp(vTexCoord + vec2(0.0, -srcStep.y * 0.75), 0.0, 1.0), uSourceSize).rgb;
            vec3 bc = textureBicubic(uTexture, clamp(vTexCoord + vec2(0.0, srcStep.y * 0.75), 0.0, 1.0), uSourceSize).rgb;
            vec3 ml = textureBicubic(uTexture, clamp(vTexCoord + vec2(-srcStep.x * 0.75, 0.0), 0.0, 1.0), uSourceSize).rgb;
            vec3 mr = textureBicubic(uTexture, clamp(vTexCoord + vec2(srcStep.x * 0.75, 0.0), 0.0, 1.0), uSourceSize).rgb;

            vec3 tl = textureBicubic(uTexture, clamp(vTexCoord + vec2(-srcStep.x * 0.75, -srcStep.y * 0.75), 0.0, 1.0), uSourceSize).rgb;
            vec3 tr = textureBicubic(uTexture, clamp(vTexCoord + vec2(srcStep.x * 0.75, -srcStep.y * 0.75), 0.0, 1.0), uSourceSize).rgb;
            vec3 bl = textureBicubic(uTexture, clamp(vTexCoord + vec2(-srcStep.x * 0.75, srcStep.y * 0.75), 0.0, 1.0), uSourceSize).rgb;
            vec3 br = textureBicubic(uTexture, clamp(vTexCoord + vec2(srcStep.x * 0.75, srcStep.y * 0.75), 0.0, 1.0), uSourceSize).rgb;

            // 1. Sobel Gradient Analysis (Edge Direction & Strength)
            float lumTL = getLum(tl), lumTC = getLum(tc), lumTR = getLum(tr);
            float lumML = getLum(ml),               lumMR = getLum(mr);
            float lumBL = getLum(bl), lumBC = getLum(bc), lumBR = getLum(br);

            float gx = (lumTR + 2.0 * lumMR + lumBR) - (lumTL + 2.0 * lumML + lumBL);
            float gy = (lumBL + 2.0 * lumBC + lumBR) - (lumTL + 2.0 * lumTC + lumTR);
            float gMag = length(vec2(gx, gy));

            // 2. Edge-Directed Super-Resolution & Line Steepening
            // Blurry upscaled pixels on edges have a wide sigmoidal slope.
            // We steepen the edge by pushing the luminance towards the high or low side.
            vec3 edgeSharpened = c;
            if (gMag > 0.04) {
              float laplacian = lumC - (lumTC + lumBC + lumML + lumMR) * 0.25;
              // Push luminance towards the dominant side of the edge
              float steepenAmount = clamp(laplacian * 2.2 * uSharpness, -0.35, 0.35);
              edgeSharpened = c + steepenAmount * (c / max(lumC, 0.01));
            }

            // 3. AMD Contrast Adaptive Sharpening (CAS) at source-pixel scale
            vec3 minRGB = min(c, min(min(tc, bc), min(ml, mr)));
            vec3 maxRGB = max(c, max(max(tc, bc), max(ml, mr)));
            vec3 contrast = maxRGB - minRGB;

            vec3 amp = clamp(min(minRGB, 1.0 - maxRGB) / max(maxRGB, 0.05), 0.0, 1.0);
            // Weight bounded between -0.18 and 0.0
            vec3 w = -sqrt(amp) * (uSharpness * 0.18);
            vec3 casColor = ((tc + bc + ml + mr) * w + edgeSharpened) / (4.0 * w + 1.0);

            // 4. Multi-Scale High-Frequency Detail & Texture Synthesis (Micro-Contrast)
            vec3 localMean = (tl + tc + tr + ml + mr + bl + bc + br + c) * (1.0 / 9.0);
            vec3 highFreq = c - localMean;
            // Boost micro-textures (fabrics, patterns, fine hair, stone grain)
            vec3 textureBoost = highFreq * (uTextureClarity * 1.35);

            // 5. Bilateral Edge-Preserving Denoising
            // If local contrast is low (smooth regions/JPEG noise), blend with localMean
            float noiseWeight = smoothstep(0.08 * (1.0 - uEdgePreserve * 0.5), 0.0, gMag) * (uDenoise * 0.7);
            vec3 denoised = mix(casColor, localMean, noiseWeight);

            // 6. Combine all passes with preservation of dynamic range
            vec3 finalColor = denoised + textureBoost;

            gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), centerSample.a);
          }
        `;

        const vs = this.compileShader(this.gl.VERTEX_SHADER, vsSource);
        const fs = this.compileShader(this.gl.FRAGMENT_SHADER, fsSource);
        if (!vs || !fs) return false;

        this.program = this.gl.createProgram();
        this.gl.attachShader(this.program, vs);
        this.gl.attachShader(this.program, fs);
        this.gl.linkProgram(this.program);

        if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
          console.error(this.gl.getProgramInfoLog(this.program));
          return false;
        }

        this.gl.useProgram(this.program);

        // Quad geometry
        const vertices = new Float32Array([
          -1, -1,  0, 0,
           1, -1,  1, 0,
          -1,  1,  0, 1,
          -1,  1,  0, 1,
           1, -1,  1, 0,
           1,  1,  1, 1,
        ]);

        const buf = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buf);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);

        const aPos = this.gl.getAttribLocation(this.program, 'aPosition');
        const aTex = this.gl.getAttribLocation(this.program, 'aTexCoord');

        this.gl.enableVertexAttribArray(aPos);
        this.gl.vertexAttribPointer(aPos, 2, this.gl.FLOAT, false, 16, 0);

        this.gl.enableVertexAttribArray(aTex);
        this.gl.vertexAttribPointer(aTex, 2, this.gl.FLOAT, false, 16, 8);

        this.initialized = true;
        return true;
      } catch (err) {
        console.error('WebGL init error:', err);
        return false;
      }
    }

    compileShader(type, src) {
      const s = this.gl.createShader(type);
      this.gl.shaderSource(s, src);
      this.gl.compileShader(s);
      if (!this.gl.getShaderParameter(s, this.gl.COMPILE_STATUS)) {
        console.error('Shader compile failed:', this.gl.getShaderInfoLog(s));
        this.gl.deleteShader(s);
        return null;
      }
      return s;
    }

    renderTile(tileCanvas, outW, outH, params) {
      const gl = this.gl;
      this.canvas.width = outW;
      this.canvas.height = outH;
      gl.viewport(0, 0, outW, outH);

      gl.useProgram(this.program);

      // Create texture from tile canvas
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tileCanvas);

      // Set uniforms
      gl.uniform2f(gl.getUniformLocation(this.program, 'uSourceSize'), tileCanvas.width, tileCanvas.height);
      gl.uniform2f(gl.getUniformLocation(this.program, 'uTargetSize'), outW, outH);
      gl.uniform1f(gl.getUniformLocation(this.program, 'uSharpness'), params.cas / 100);
      gl.uniform1f(gl.getUniformLocation(this.program, 'uDenoise'), params.denoise / 100);
      gl.uniform1f(gl.getUniformLocation(this.program, 'uTextureClarity'), params.texture / 100);
      gl.uniform1f(gl.getUniformLocation(this.program, 'uEdgePreserve'), params.edge / 100);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.deleteTexture(texture);
      return this.canvas;
    }
  }

  // --- CPU Fallback Engine ---
  class CPUEngine {
    renderTile(tileCanvas, outW, outH, params) {
      // High-quality canvas scaling
      const offscreen = document.createElement('canvas');
      offscreen.width = outW;
      offscreen.height = outH;
      const ctx = offscreen.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tileCanvas, 0, 0, outW, outH);

      // Pixel convolution pass
      const imgData = ctx.getImageData(0, 0, outW, outH);
      const data = imgData.data;
      const copy = new Uint8ClampedArray(data);
      const w = outW;
      const h = outH;

      const scale = Math.max(1, Math.round(outW / tileCanvas.width));
      const r = Math.max(1, Math.round(scale * 0.75));

      const sharpness = (params.cas / 100) * 1.5;
      const denoise = (params.denoise / 100) * 0.6;
      const clarity = (params.texture / 100) * 1.2;

      for (let y = r; y < h - r; y++) {
        const row = y * w;
        for (let x = r; x < w - r; x++) {
          const idx = (row + x) * 4;

          for (let c = 0; c < 3; c++) {
            const val = copy[idx + c];
            const up = copy[((y - r) * w + x) * 4 + c];
            const down = copy[((y + r) * w + x) * 4 + c];
            const left = copy[(row + (x - r)) * 4 + c];
            const right = copy[(row + (x + r)) * 4 + c];

            const minN = Math.min(val, Math.min(Math.min(up, down), Math.min(left, right)));
            const maxN = Math.max(val, Math.max(Math.max(up, down), Math.max(left, right)));
            const contrast = (maxN - minN) / 255;

            // Edge steepening & CAS
            const laplacian = val - (up + down + left + right) * 0.25;
            const casVal = val + laplacian * (sharpness * (1.0 - contrast * 0.5));

            // Denoise
            const avg = (up + down + left + right + val) * 0.2;
            const diff = Math.abs(val - avg);
            const denoiseWeight = diff < 15 ? denoise : 0.0;
            const smoothed = casVal * (1.0 - denoiseWeight) + avg * denoiseWeight;

            // Micro-contrast
            const finalVal = smoothed + laplacian * clarity;
            data[idx + c] = Math.min(255, Math.max(0, finalVal));
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);
      return offscreen;
    }
  }

  // --- Real-ESRGAN Deep Learning AI Engine ---
  class RealESRGANEngine {
    constructor() {
      this.session = null;
      this.isLoading = false;
      this.modelUrl = './models/realesr-general-x4v3.onnx';
    }

    async init(onProgress) {
      if (this.session) return this.session;
      if (this.isLoading) {
        while (this.isLoading) {
          await new Promise(r => setTimeout(r, 100));
        }
        return this.session;
      }

      this.isLoading = true;
      if (onProgress) onProgress(15, 'Memuat model AI Real-ESRGAN (4.6 MB)...');

      try {
        if (typeof ort === 'undefined') {
          throw new Error('Library ONNX Runtime Web belum tersedia');
        }

        // Use local SIMD WebAssembly for maximum speed without network delays
        ort.env.wasm.wasmPaths = './';
        ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);

        this.session = await ort.InferenceSession.create(this.modelUrl, {
          executionProviders: ['wasm']
        });

        this.isLoading = false;
        return this.session;
      } catch (err) {
        this.isLoading = false;
        console.error('Failed to load Real-ESRGAN model:', err);
        throw err;
      }
    }

    async processImage(sourceImg, targetScale, onProgress, checkCancelled) {
      await this.init(onProgress);

      const srcW = sourceImg.naturalWidth || sourceImg.width;
      const srcH = sourceImg.naturalHeight || sourceImg.height;

      // Source staging canvas
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = srcW;
      srcCanvas.height = srcH;
      const srcCtx = srcCanvas.getContext('2d');
      srcCtx.drawImage(sourceImg, 0, 0);

      // AI native 4x canvas
      const ai4xCanvas = document.createElement('canvas');
      ai4xCanvas.width = srcW * 4;
      ai4xCanvas.height = srcH * 4;
      const ai4xCtx = ai4xCanvas.getContext('2d');

      // Optimized tile size: 96px runs at ~0.3s per tile on SIMD WASM
      const tileSize = 96;
      const overlap = 8;

      const cols = Math.ceil(srcW / tileSize);
      const rows = Math.ceil(srcH / tileSize);
      const totalTiles = cols * rows;
      let currentTile = 0;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (checkCancelled && checkCancelled()) {
            throw new Error('PROSES_DIBATALKAN');
          }

          currentTile++;

          const sx = Math.max(0, c * tileSize - overlap);
          const sy = Math.max(0, r * tileSize - overlap);
          const ex = Math.min(srcW, (c + 1) * tileSize + overlap);
          const ey = Math.min(srcH, (r + 1) * tileSize + overlap);
          let sw = ex - sx;
          let sh = ey - sy;

          // Strictly enforce multiples of 4 for CNN spatial dimension requirements
          sw = Math.max(4, Math.floor(sw / 4) * 4);
          sh = Math.max(4, Math.floor(sh / 4) * 4);

          const tileImgData = srcCtx.getImageData(sx, sy, sw, sh);
          const pixels = tileImgData.data;
          const planeSize = sw * sh;
          const inputData = new Float32Array(3 * planeSize);

          for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
            inputData[p] = pixels[i] / 255.0;
            inputData[p + planeSize] = pixels[i + 1] / 255.0;
            inputData[p + 2 * planeSize] = pixels[i + 2] / 255.0;
          }

          const inputTensor = new ort.Tensor('float32', inputData, [1, 3, sh, sw]);
          const results = await this.session.run({ input: inputTensor });
          const outData = results.output.data;

          const outTileW = sw * 4;
          const outTileH = sh * 4;
          const outPlane = outTileW * outTileH;

          const tileCanvas = document.createElement('canvas');
          tileCanvas.width = outTileW;
          tileCanvas.height = outTileH;
          const tileCtx = tileCanvas.getContext('2d');
          const outImgData = tileCtx.createImageData(outTileW, outTileH);
          const outPixels = outImgData.data;

          for (let p = 0, idx = 0; p < outPlane; p++, idx += 4) {
            outPixels[idx] = Math.min(255, Math.max(0, Math.round(outData[p] * 255.0)));
            outPixels[idx + 1] = Math.min(255, Math.max(0, Math.round(outData[p + outPlane] * 255.0)));
            outPixels[idx + 2] = Math.min(255, Math.max(0, Math.round(outData[p + 2 * outPlane] * 255.0)));
            outPixels[idx + 3] = 255;
          }
          tileCtx.putImageData(outImgData, 0, 0);

          const innerSx = (c === 0) ? 0 : overlap;
          const innerSy = (r === 0) ? 0 : overlap;
          const innerEx = (c === cols - 1) ? sw : sw - overlap;
          const innerEy = (r === rows - 1) ? sh : sh - overlap;
          const innerSw = innerEx - innerSx;
          const innerSh = innerEy - innerSy;

          ai4xCtx.drawImage(
            tileCanvas,
            innerSx * 4, innerSy * 4, innerSw * 4, innerSh * 4,
            (sx + innerSx) * 4, (sy + innerSy) * 4, innerSw * 4, innerSh * 4
          );

          const percent = Math.round((currentTile / totalTiles) * 100);
          if (onProgress) {
            onProgress(percent, `AI Real-ESRGAN: Ubin ${currentTile} dari ${totalTiles} (${percent}%)`);
          }

          await new Promise(res => setTimeout(res, 4));
        }
      }

      if (targetScale === 4) {
        return ai4xCanvas;
      }

      const finalW = Math.round(srcW * targetScale);
      const finalH = Math.round(srcH * targetScale);
      const finalCanvas = document.createElement('canvas');
      finalCanvas.width = finalW;
      finalCanvas.height = finalH;
      const finalCtx = finalCanvas.getContext('2d');
      finalCtx.imageSmoothingEnabled = true;
      finalCtx.imageSmoothingQuality = 'high';
      finalCtx.drawImage(ai4xCanvas, 0, 0, finalW, finalH);

      return finalCanvas;
    }
  }

  // --- ESPCN / FSRCNN Ultra-Light Mobile AI Engine ---
  class ESPCNEngine {
    constructor() {
      this.session = null;
      this.isLoading = false;
      this.modelUrl = './models/espcn-x4.onnx';
    }

    async init(onProgress) {
      if (this.session) return this.session;
      if (this.isLoading) {
        while (this.isLoading) {
          await new Promise(r => setTimeout(r, 50));
        }
        return this.session;
      }

      this.isLoading = true;
      if (onProgress) onProgress(20, 'Memuat model AI Ultra-Ringan ESPCN (99 KB)...');

      try {
        if (typeof ort === 'undefined') {
          throw new Error('Library ONNX Runtime Web belum tersedia');
        }

        ort.env.wasm.wasmPaths = './';
        ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);

        this.session = await ort.InferenceSession.create(this.modelUrl, {
          executionProviders: ['wasm']
        });

        this.isLoading = false;
        return this.session;
      } catch (err) {
        this.isLoading = false;
        console.error('Failed to load ESPCN model:', err);
        throw err;
      }
    }

    async processImage(sourceImg, targetScale, onProgress, checkCancelled) {
      await this.init(onProgress);

      const srcW = sourceImg.naturalWidth || sourceImg.width;
      const srcH = sourceImg.naturalHeight || sourceImg.height;

      if (onProgress) onProgress(35, 'Memproses AI ESPCN 4x...');

      // Pad dimensions to multiples of 4 if needed
      const padW = Math.ceil(srcW / 4) * 4;
      const padH = Math.ceil(srcH / 4) * 4;

      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = padW;
      srcCanvas.height = padH;
      const srcCtx = srcCanvas.getContext('2d');
      srcCtx.drawImage(sourceImg, 0, 0);

      const imgData = srcCtx.getImageData(0, 0, padW, padH);
      const pixels = imgData.data;
      const totalPixels = padW * padH;

      const yPlane = new Float32Array(totalPixels);
      const cbCanvas = document.createElement('canvas');
      cbCanvas.width = padW;
      cbCanvas.height = padH;
      const cbCtx = cbCanvas.getContext('2d');
      const cbImgData = cbCtx.createImageData(padW, padH);
      const cbData = cbImgData.data;

      const crCanvas = document.createElement('canvas');
      crCanvas.width = padW;
      crCanvas.height = padH;
      const crCtx = crCanvas.getContext('2d');
      const crImgData = crCtx.createImageData(padW, padH);
      const crData = crImgData.data;

      for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        // Luminance Y in [0, 1] for neural input
        yPlane[p] = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;

        const cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
        const cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;

        cbData[i] = cb; cbData[i + 1] = cb; cbData[i + 2] = cb; cbData[i + 3] = 255;
        crData[i] = cr; crData[i + 1] = cr; crData[i + 2] = cr; crData[i + 3] = 255;
      }
      cbCtx.putImageData(cbImgData, 0, 0);
      crCtx.putImageData(crImgData, 0, 0);

      if (checkCancelled && checkCancelled()) throw new Error('PROSES_DIBATALKAN');

      const outPadW = padW * 4;
      const outPadH = padH * 4;

      // 4x Bicubic upscale of chroma channels
      const cb4x = document.createElement('canvas');
      cb4x.width = outPadW; cb4x.height = outPadH;
      const cb4xCtx = cb4x.getContext('2d');
      cb4xCtx.imageSmoothingEnabled = true;
      cb4xCtx.imageSmoothingQuality = 'high';
      cb4xCtx.drawImage(cbCanvas, 0, 0, outPadW, outPadH);
      const cb4xData = cb4xCtx.getImageData(0, 0, outPadW, outPadH).data;

      const cr4x = document.createElement('canvas');
      cr4x.width = outPadW; cr4x.height = outPadH;
      const cr4xCtx = cr4x.getContext('2d');
      cr4xCtx.imageSmoothingEnabled = true;
      cr4xCtx.imageSmoothingQuality = 'high';
      cr4xCtx.drawImage(crCanvas, 0, 0, outPadW, outPadH);
      const cr4xData = cr4xCtx.getImageData(0, 0, outPadW, outPadH).data;

      if (onProgress) onProgress(60, 'Menjalankan inferensi Neural Network ESPCN...');
      await new Promise(r => setTimeout(r, 4));

      // Run ESPCN model on Y channel
      const inputTensor = new ort.Tensor('float32', yPlane, [1, 1, padH, padW]);
      const results = await this.session.run({ input: inputTensor });
      const outY = results.output.data;

      if (onProgress) onProgress(85, 'Menggabungkan warna RGB...');

      const ai4xW = srcW * 4;
      const ai4xH = srcH * 4;
      const ai4xCanvas = document.createElement('canvas');
      ai4xCanvas.width = ai4xW;
      ai4xCanvas.height = ai4xH;
      const ai4xCtx = ai4xCanvas.getContext('2d');
      const finalImgData = ai4xCtx.createImageData(ai4xW, ai4xH);
      const outPixels = finalImgData.data;

      // Convert high-res Y + CbCr back to RGB
      for (let y = 0; y < ai4xH; y++) {
        const rowSrc = y * outPadW;
        const rowDst = y * ai4xW;
        for (let x = 0; x < ai4xW; x++) {
          const p = rowSrc + x;
          const idx = (rowDst + x) * 4;

          const yVal = outY[p] * 255.0;
          const cb = cb4xData[p * 4] - 128;
          const cr = cr4xData[p * 4] - 128;

          const r = yVal + 1.402 * cr;
          const g = yVal - 0.344136 * cb - 0.714136 * cr;
          const b = yVal + 1.772 * cb;

          outPixels[idx] = Math.min(255, Math.max(0, Math.round(r)));
          outPixels[idx + 1] = Math.min(255, Math.max(0, Math.round(g)));
          outPixels[idx + 2] = Math.min(255, Math.max(0, Math.round(b)));
          outPixels[idx + 3] = 255;
        }
      }
      ai4xCtx.putImageData(finalImgData, 0, 0);

      if (targetScale === 4) {
        if (onProgress) onProgress(100, 'Selesai!');
        return ai4xCanvas;
      }

      // If user selected 1x, 2x, or 3x
      const finalW = Math.round(srcW * targetScale);
      const finalH = Math.round(srcH * targetScale);
      const finalCanvas = document.createElement('canvas');
      finalCanvas.width = finalW;
      finalCanvas.height = finalH;
      const finalCtx = finalCanvas.getContext('2d');
      finalCtx.imageSmoothingEnabled = true;
      finalCtx.imageSmoothingQuality = 'high';
      finalCtx.drawImage(ai4xCanvas, 0, 0, finalW, finalH);

      if (onProgress) onProgress(100, 'Selesai!');
      return finalCanvas;
    }
  }

  // --- Tiling & Pipeline Coordinator ---
  class PipelineProcessor {
    constructor(deviceProfile) {
      this.device = deviceProfile;
      this.espcnEngine = new ESPCNEngine();
      this.aiEngine = new RealESRGANEngine();
      this.webglEngine = new WebGLEngine();
      this.cpuEngine = new CPUEngine();
      this.active = false;
      this.cancelled = false;
    }

    cancel() {
      this.cancelled = true;
    }

    async process(sourceImg, scale, params, engineChoice, onProgress) {
      this.active = true;
      this.cancelled = false;

      // Ultra-Fast Mobile AI Engine: ESPCN / FSRCNN
      if (engineChoice === 'espcn') {
        const result = await this.espcnEngine.processImage(sourceImg, scale, onProgress, () => this.cancelled);
        this.active = false;
        return result;
      }

      // Heavy Deep Learning Super-Resolution Engine: Real-ESRGAN
      if (engineChoice === 'ai') {
        const result = await this.aiEngine.processImage(sourceImg, scale, onProgress, () => this.cancelled);
        this.active = false;
        return result;
      }

      const srcW = sourceImg.naturalWidth || sourceImg.width;
      const srcH = sourceImg.naturalHeight || sourceImg.height;
      const dstW = Math.round(srcW * scale);
      const dstH = Math.round(srcH * scale);

      // Determine engine
      let useWebGL = false;
      if (engineChoice === 'webgl' || engineChoice === 'auto') {
        useWebGL = this.webglEngine.init();
      }

      const finalCanvas = document.createElement('canvas');
      finalCanvas.width = dstW;
      finalCanvas.height = dstH;
      const finalCtx = finalCanvas.getContext('2d');
      finalCtx.imageSmoothingEnabled = false;

      const tileSize = this.device.tileSize;
      const overlap = this.device.tileOverlap;

      // Fast single-pass execution if image fits comfortably within one tile
      if (srcW <= tileSize && srcH <= tileSize) {
        onProgress(40, 'Rekonstruksi pixel langsung...');
        const tileCanvas = document.createElement('canvas');
        tileCanvas.width = srcW;
        tileCanvas.height = srcH;
        const tileCtx = tileCanvas.getContext('2d');
        tileCtx.drawImage(sourceImg, 0, 0, srcW, srcH);

        let processedTile;
        if (useWebGL) {
          processedTile = this.webglEngine.renderTile(tileCanvas, dstW, dstH, params);
        } else {
          processedTile = this.cpuEngine.renderTile(tileCanvas, dstW, dstH, params);
        }

        finalCtx.drawImage(processedTile, 0, 0, dstW, dstH);
        onProgress(100, 'Rekonstruksi pixel selesai!');
        this.active = false;
        return finalCanvas;
      }

      // Calculate tile count for larger images
      const cols = Math.ceil(srcW / tileSize);
      const rows = Math.ceil(srcH / tileSize);
      const totalTiles = cols * rows;
      let currentTile = 0;

      onProgress(0, `Menyiapkan ${totalTiles} bagian pemrosesan...`);

      // Offscreen tile staging canvas
      const tileCanvas = document.createElement('canvas');
      const tileCtx = tileCanvas.getContext('2d');

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (this.cancelled) {
            this.active = false;
            throw new Error('PROSES_DIBATALKAN');
          }

          currentTile++;

          // Source bounds with overlap
          const sx = Math.max(0, c * tileSize - overlap);
          const sy = Math.max(0, r * tileSize - overlap);
          const ex = Math.min(srcW, (c + 1) * tileSize + overlap);
          const ey = Math.min(srcH, (r + 1) * tileSize + overlap);
          const sw = ex - sx;
          const sh = ey - sy;

          // Target output dimensions for this tile
          const tow = Math.round(sw * scale);
          const toh = Math.round(sh * scale);

          tileCanvas.width = sw;
          tileCanvas.height = sh;
          tileCtx.clearRect(0, 0, sw, sh);
          tileCtx.drawImage(sourceImg, sx, sy, sw, sh, 0, 0, sw, sh);

          let processedTile;
          if (useWebGL) {
            processedTile = this.webglEngine.renderTile(tileCanvas, tow, toh, params);
          } else {
            processedTile = this.cpuEngine.renderTile(tileCanvas, tow, toh, params);
          }

          // Compute valid interior destination without overlap margin
          const innerSx = (c === 0) ? 0 : overlap;
          const innerSy = (r === 0) ? 0 : overlap;
          const innerEx = (c === cols - 1) ? sw : sw - overlap;
          const innerEy = (r === rows - 1) ? sh : sh - overlap;
          const innerSw = innerEx - innerSx;
          const innerSh = innerEy - innerSy;

          const dstX = Math.round((sx + innerSx) * scale);
          const dstY = Math.round((sy + innerSy) * scale);
          const dstTileW = Math.round(innerSw * scale);
          const dstTileH = Math.round(innerSh * scale);

          finalCtx.drawImage(
            processedTile,
            Math.round(innerSx * scale), Math.round(innerSy * scale),
            dstTileW, dstTileH,
            dstX, dstY,
            dstTileW, dstTileH
          );

          const percent = Math.round((currentTile / totalTiles) * 100);
          onProgress(percent, `Memproses bagian ${currentTile} dari ${totalTiles} (${percent}%)`);

          // Crucial: Yield to UI thread so mobile Chrome doesn't freeze or drop frames
          await new Promise(res => setTimeout(res, 4));
        }
      }

      onProgress(100, 'Rekonstruksi pixel selesai!');
      this.active = false;
      return finalCanvas;
    }
  }

  // --- Interactive Comparison Viewer Controller ---
  class ComparisonViewer {
    constructor() {
      this.stage = document.getElementById('viewerStage');
      this.panContainer = document.getElementById('panContainer');
      this.compareFrame = document.getElementById('compareFrame');
      this.splitWrapper = document.getElementById('splitComparisonWrapper');
      this.sideWrapper = document.getElementById('sideBySideWrapper');
      this.enhancedLayer = document.getElementById('layerEnhancedWrapper');
      this.divider = document.getElementById('splitDivider');
      
      this.imgOriginal = document.getElementById('imgOriginal');
      this.imgEnhanced = document.getElementById('imgEnhanced');
      this.imgSideOriginal = document.getElementById('imgSideOriginal');
      this.imgSideEnhanced = document.getElementById('imgSideEnhanced');

      this.zoomDisplay = document.getElementById('zoomLevelDisplay');
      
      this.splitPos = 50; // percentage
      this.zoomLevel = 1.0;
      this.panX = 0;
      this.panY = 0;
      
      this.isDraggingDivider = false;
      this.isPanning = false;
      this.dragStartX = 0;
      this.dragStartY = 0;
      this.initialPanX = 0;
      this.initialPanY = 0;

      this.viewMode = 'split'; // 'split', 'side', 'blink'

      this.initEvents();
    }

    initEvents() {
      // Divider drag on pointerdown
      this.divider.addEventListener('pointerdown', (e) => {
        this.isDraggingDivider = true;
        this.divider.setPointerCapture(e.pointerId);
        e.stopPropagation();
      });

      window.addEventListener('pointermove', (e) => {
        if (this.isDraggingDivider) {
          const rect = (this.compareFrame || this.splitWrapper).getBoundingClientRect();
          let x = e.clientX - rect.left;
          x = Math.max(0, Math.min(rect.width, x));
          this.splitPos = (x / rect.width) * 100;
          this.updateSplitPosition();
        } else if (this.isPanning) {
          const dx = e.clientX - this.dragStartX;
          const dy = e.clientY - this.dragStartY;
          this.panX = this.initialPanX + dx;
          this.panY = this.initialPanY + dy;
          this.updateTransform();
        }
      });

      window.addEventListener('pointerup', (e) => {
        if (this.isDraggingDivider) {
          this.isDraggingDivider = false;
          try { this.divider.releasePointerCapture(e.pointerId); } catch (_) {}
        }
        if (this.isPanning) {
          this.isPanning = false;
          this.stage.classList.remove('grabbing');
        }
      });

      // Pan stage on drag when not clicking divider
      this.stage.addEventListener('pointerdown', (e) => {
        if (this.isDraggingDivider) return;
        if (this.viewMode === 'blink') return;
        this.isPanning = true;
        this.stage.classList.add('grabbing');
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.initialPanX = this.panX;
        this.initialPanY = this.panY;
      });

      // Mouse wheel zoom
      this.stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.85 : 1.15;
        this.setZoom(this.zoomLevel * delta);
      }, { passive: false });

      // Blink / Hold view buttons
      const startBlink = (e) => {
        if (this.viewMode !== 'blink') return;
        e.preventDefault();
        this.enhancedLayer.style.opacity = '0';
      };
      const endBlink = (e) => {
        if (this.viewMode !== 'blink') return;
        this.enhancedLayer.style.opacity = '1';
      };

      this.stage.addEventListener('pointerdown', startBlink);
      this.stage.addEventListener('pointerup', endBlink);
      this.stage.addEventListener('pointerleave', endBlink);
    }

    setImages(origSrc, enhSrc, naturalW, naturalH) {
      this.imgOriginal.src = origSrc;
      this.imgEnhanced.src = enhSrc;
      this.imgSideOriginal.src = origSrc;
      this.imgSideEnhanced.src = enhSrc;

      this.naturalW = naturalW;
      this.naturalH = naturalH;

      this.resetZoomAndPan();
    }

    updateSplitPosition() {
      const pct = Math.max(0, Math.min(100, this.splitPos));
      if (this.compareFrame) {
        this.compareFrame.style.setProperty('--split-pct', `${pct}%`);
      }
    }

    resetZoomAndPan() {
      this.zoomLevel = 1.0;
      this.panX = 0;
      this.panY = 0;
      this.splitPos = 50;
      this.updateSplitPosition();
      this.updateTransform();
      this.zoomDisplay.textContent = 'Fit';
    }

    setZoom(targetZoom) {
      this.zoomLevel = Math.max(0.2, Math.min(8.0, targetZoom));
      this.updateTransform();
      this.zoomDisplay.textContent = `${Math.round(this.zoomLevel * 100)}%`;
    }

    updateTransform() {
      // Keep pan within sensible limits
      this.panContainer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoomLevel})`;
    }

    setViewMode(mode) {
      this.viewMode = mode;
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

      if (mode === 'split') {
        document.getElementById('tabSplitView').classList.add('active');
        this.splitWrapper.style.display = 'flex';
        this.sideWrapper.style.display = 'none';
        this.updateSplitPosition();
        this.divider.style.display = 'block';
        this.enhancedLayer.style.opacity = '1';
      } else if (mode === 'side') {
        document.getElementById('tabSideView').classList.add('active');
        this.splitWrapper.style.display = 'none';
        this.sideWrapper.style.display = 'grid';
      } else if (mode === 'blink') {
        document.getElementById('tabBlinkView').classList.add('active');
        this.splitWrapper.style.display = 'flex';
        this.sideWrapper.style.display = 'none';
        this.divider.style.display = 'none';
        if (this.compareFrame) {
          this.compareFrame.style.setProperty('--split-pct', '0%');
        }
        this.enhancedLayer.style.opacity = '1';
      }
    }
  }

  // --- Main Application State & Coordinator ---
  class App {
    constructor() {
      this.device = new DeviceProfile();
      this.pipeline = new PipelineProcessor(this.device);
      this.viewer = new ComparisonViewer();

      this.queue = [];
      this.currentIndex = 0;
      this.currentScale = 2;
      this.currentPreset = 'balanced';
      this.isProcessing = false;
      this.latestEnhancedBlob = null;
      this.latestEnhancedUrl = null;

      this.initDomElements();
      this.bindEvents();
      this.applyDeviceBadge();
      this.registerServiceWorker();
    }

    initDomElements() {
      this.dom = {
        dropzoneSection: document.getElementById('dropzoneSection'),
        dropzoneBox: document.getElementById('dropzoneBox'),
        fileInput: document.getElementById('fileInput'),
        browseBtn: document.getElementById('browseBtn'),
        pasteBtn: document.getElementById('pasteBtn'),

        workspaceSection: document.getElementById('workspaceSection'),
        currentFileName: document.getElementById('currentFileName'),
        origDimBadge: document.getElementById('origDimBadge'),
        targetDimBadge: document.getElementById('targetDimBadge'),
        scaleRatioBadge: document.getElementById('scaleRatioBadge'),
        selectedScaleText: document.getElementById('selectedScaleText'),

        scaleButtons: document.querySelectorAll('.scale-btn'),
        presetSelect: document.getElementById('presetSelect'),

        sliderCas: document.getElementById('sliderCas'),
        valCas: document.getElementById('valCas'),
        sliderDenoise: document.getElementById('sliderDenoise'),
        valDenoise: document.getElementById('valDenoise'),
        sliderTexture: document.getElementById('sliderTexture'),
        valTexture: document.getElementById('valTexture'),
        sliderEdge: document.getElementById('sliderEdge'),
        valEdge: document.getElementById('valEdge'),

        engineRadios: document.querySelectorAll('input[name="engineMode"]'),
        formatRadios: document.querySelectorAll('input[name="exportFormat"]'),
        jpegQualityGroup: document.getElementById('jpegQualityGroup'),
        sliderJpegQ: document.getElementById('sliderJpegQ'),
        valJpegQ: document.getElementById('valJpegQ'),

        processBtn: document.getElementById('processBtn'),
        downloadBtn: document.getElementById('downloadBtn'),
        copyClipboardBtn: document.getElementById('copyClipboardBtn'),

        addMoreBtn: document.getElementById('addMoreBtn'),
        resetAllBtn: document.getElementById('resetAllBtn'),

        batchSection: document.getElementById('batchSection'),
        batchCountText: document.getElementById('batchCountText'),
        batchGrid: document.getElementById('batchGrid'),
        batchProcessAllBtn: document.getElementById('batchProcessAllBtn'),
        batchDownloadZipBtn: document.getElementById('batchDownloadZipBtn'),

        progressOverlay: document.getElementById('progressOverlay'),
        progressStageTitle: document.getElementById('progressStageTitle'),
        progressSubtitle: document.getElementById('progressSubtitle'),
        progressBarFill: document.getElementById('progressBarFill'),
        progressPercent: document.getElementById('progressPercent'),
        cancelProcessBtn: document.getElementById('cancelProcessBtn'),

        mobileStickyBar: document.getElementById('mobileStickyBar'),
        mobileStatusText: document.getElementById('mobileStatusText'),
        mobileScaleText: document.getElementById('mobileScaleText'),
        mobileProcessBtn: document.getElementById('mobileProcessBtn'),
        mobileDownloadBtn: document.getElementById('mobileDownloadBtn'),

        themeToggleBtn: document.getElementById('themeToggleBtn'),
        toastContainer: document.getElementById('toastContainer')
      };
    }

    applyDeviceBadge() {
      const badge = document.getElementById('deviceBadge');
      const text = document.getElementById('deviceText');
      badge.classList.add('gpu-active');
      text.textContent = 'AI Real-ESRGAN Aktif';
    }

    bindEvents() {
      // File Drop & Pick
      this.dom.dropzoneBox.addEventListener('click', (e) => {
        if (e.target !== this.dom.pasteBtn && !this.dom.pasteBtn.contains(e.target)) {
          this.dom.fileInput.click();
        }
      });
      this.dom.browseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.dom.fileInput.click();
      });
      this.dom.fileInput.addEventListener('change', (e) => this.handleFiles(e.target.files));

      // Drag and Drop
      ['dragenter', 'dragover'].forEach(name => {
        this.dom.dropzoneBox.addEventListener(name, (e) => {
          e.preventDefault();
          this.dom.dropzoneBox.classList.add('drag-over');
        });
      });
      ['dragleave', 'drop'].forEach(name => {
        this.dom.dropzoneBox.addEventListener(name, (e) => {
          e.preventDefault();
          this.dom.dropzoneBox.classList.remove('drag-over');
        });
      });
      this.dom.dropzoneBox.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files.length) {
          this.handleFiles(e.dataTransfer.files);
        }
      });

      // Paste from Clipboard
      this.dom.pasteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pasteFromClipboard();
      });
      window.addEventListener('paste', (e) => {
        if (e.clipboardData && e.clipboardData.files.length) {
          this.handleFiles(e.clipboardData.files);
        }
      });

      // Scale buttons
      this.dom.scaleButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          this.dom.scaleButtons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.currentScale = parseInt(btn.dataset.scale, 10);
          this.updateDimensionsInfo();
          this.dom.selectedScaleText.textContent = `${this.currentScale}x Resolusi`;
          this.dom.mobileScaleText.textContent = `Skala ${this.currentScale}x`;
          this.autoTriggerProcess();
        });
      });

      // Preset Selector
      this.dom.presetSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        this.currentPreset = val;
        if (val !== 'custom') {
          const p = PRESETS[val];
          if (p) {
            this.dom.sliderCas.value = p.cas;
            this.dom.valCas.textContent = `${p.cas}%`;
            this.dom.sliderDenoise.value = p.denoise;
            this.dom.valDenoise.textContent = `${p.denoise}%`;
            this.dom.sliderTexture.value = p.texture;
            this.dom.valTexture.textContent = `${p.texture}%`;
            this.dom.sliderEdge.value = p.edge;
            this.dom.valEdge.textContent = `${p.edge}%`;
          }
        }
        this.autoTriggerProcess();
      });

      // Sliders Live Update
      const bindSlider = (slider, valDisplay) => {
        slider.addEventListener('input', () => {
          valDisplay.textContent = `${slider.value}%`;
          this.dom.presetSelect.value = 'custom';
          this.currentPreset = 'custom';
        });
        slider.addEventListener('change', () => this.autoTriggerProcess());
      };

      bindSlider(this.dom.sliderCas, this.dom.valCas);
      bindSlider(this.dom.sliderDenoise, this.dom.valDenoise);
      bindSlider(this.dom.sliderTexture, this.dom.valTexture);
      bindSlider(this.dom.sliderEdge, this.dom.valEdge);

      // JPEG Quality Slider
      this.dom.sliderJpegQ.addEventListener('input', () => {
        this.dom.valJpegQ.textContent = `${this.dom.sliderJpegQ.value}%`;
      });

      // Format radios
      this.dom.formatRadios.forEach(r => {
        r.addEventListener('change', () => {
          this.dom.jpegQualityGroup.style.display = r.value === 'jpeg' ? 'block' : 'none';
        });
      });

      // Engine radios change
      this.dom.engineRadios.forEach(r => {
        r.addEventListener('change', () => {
          const val = this.getSelectedEngine();
          const label = val === 'espcn' ? 'Beralih ke AI Ultra-Ringan (ESPCN / FSRCNN)' :
                        val === 'ai' ? 'Beralih ke AI Real-ESRGAN (Berat)' :
                        val === 'webgl' ? 'Beralih ke Shader GPU Cepat' : 'Beralih ke CPU Canvas';
          this.showToast(label, 'info');
          this.processCurrentItem();
        });
      });

      // Main Action Buttons
      this.dom.processBtn.addEventListener('click', () => this.processCurrentItem());
      this.dom.mobileProcessBtn.addEventListener('click', () => this.processCurrentItem());
      this.dom.downloadBtn.addEventListener('click', () => this.downloadCurrentItem());
      this.dom.mobileDownloadBtn.addEventListener('click', () => this.downloadCurrentItem());
      this.dom.copyClipboardBtn.addEventListener('click', () => this.copyToClipboard());

      // Zoom Buttons
      document.getElementById('zoomInBtn').addEventListener('click', () => this.viewer.setZoom(this.viewer.zoomLevel * 1.3));
      document.getElementById('zoomOutBtn').addEventListener('click', () => this.viewer.setZoom(this.viewer.zoomLevel / 1.3));
      document.getElementById('zoomResetBtn').addEventListener('click', () => this.viewer.resetZoomAndPan());
      document.getElementById('zoom100Btn').addEventListener('click', () => this.viewer.setZoom(1.0));
      document.getElementById('zoom200Btn').addEventListener('click', () => this.viewer.setZoom(2.0));

      // View Mode Tabs
      document.getElementById('tabSplitView').addEventListener('click', () => this.viewer.setViewMode('split'));
      document.getElementById('tabSideView').addEventListener('click', () => this.viewer.setViewMode('side'));
      document.getElementById('tabBlinkView').addEventListener('click', () => this.viewer.setViewMode('blink'));

      // Add more / Reset
      this.dom.addMoreBtn.addEventListener('click', () => this.dom.fileInput.click());
      this.dom.resetAllBtn.addEventListener('click', () => this.resetAll());

      // Cancel processing
      this.dom.cancelProcessBtn.addEventListener('click', () => {
        this.pipeline.cancel();
        this.isProcessing = false;
        this.hideProgress();
        this.showToast('Pemrosesan dibatalkan', 'info');
      });

      // Batch Actions
      this.dom.batchProcessAllBtn.addEventListener('click', () => this.processAllBatch());
      this.dom.batchDownloadZipBtn.addEventListener('click', () => this.downloadBatchZip());

      // Theme toggle
      this.dom.themeToggleBtn.addEventListener('click', () => this.toggleTheme());
    }

    async pasteFromClipboard() {
      try {
        if (!navigator.clipboard || !navigator.clipboard.read) {
          this.showToast('Gunakan pintasan Ctrl+V untuk menempel gambar', 'info');
          return;
        }
        const items = await navigator.clipboard.read();
        const files = [];
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type);
              files.push(new File([blob], `clipboard-image-${Date.now()}.png`, { type }));
            }
          }
        }
        if (files.length > 0) {
          this.handleFiles(files);
        } else {
          this.showToast('Tidak ada gambar di clipboard', 'info');
        }
      } catch (err) {
        this.showToast('Gunakan pintasan Ctrl+V untuk menempel gambar', 'info');
      }
    }

    async handleFiles(fileList) {
      if (!fileList || fileList.length === 0) return;
      const validFiles = Array.from(fileList).filter(f => f.type.startsWith('image/'));
      if (validFiles.length === 0) {
        this.showToast('Harap pilih file gambar (JPG, PNG, WebP)', 'error');
        return;
      }

      for (const file of validFiles) {
        const item = {
          id: `img_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          file: file,
          name: file.name,
          originalUrl: URL.createObjectURL(file),
          imgElement: null,
          width: 0,
          height: 0,
          enhancedCanvas: null,
          enhancedBlob: null,
          enhancedUrl: null,
          status: 'ready' // 'ready', 'processing', 'done'
        };

        await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            item.imgElement = img;
            item.width = img.naturalWidth || img.width;
            item.height = img.naturalHeight || img.height;
            resolve();
          };
          img.src = item.originalUrl;
        });

        this.queue.push(item);
      }

      this.updateQueueUI();
      this.selectQueueItem(this.queue.length - validFiles.length);
    }

    updateQueueUI() {
      if (this.queue.length === 0) {
        this.dom.workspaceSection.style.display = 'none';
        this.dom.dropzoneSection.style.display = 'block';
        document.body.classList.remove('has-image');
        return;
      }

      this.dom.workspaceSection.style.display = 'block';
      this.dom.dropzoneSection.style.display = 'none';
      document.body.classList.add('has-image');

      if (this.queue.length > 1) {
        this.dom.batchSection.style.display = 'block';
        this.dom.batchCountText.textContent = this.queue.length;
        this.renderBatchGrid();
      } else {
        this.dom.batchSection.style.display = 'none';
      }
    }

    renderBatchGrid() {
      this.dom.batchGrid.innerHTML = '';
      this.queue.forEach((item, idx) => {
        const card = document.createElement('div');
        card.className = `batch-card ${idx === this.currentIndex ? 'active-item' : ''}`;
        card.innerHTML = `
          <img src="${item.originalUrl}" alt="Thumbnail" class="batch-thumb">
          <div class="batch-info">
            <div class="batch-file-name" title="${item.name}">${item.name}</div>
            <div class="batch-dims">${item.width} x ${item.height} px &rarr; ${Math.round(item.width * this.currentScale)} x ${Math.round(item.height * this.currentScale)} px</div>
            <span class="batch-status-badge ${item.status === 'done' ? 'batch-status-done' : 'batch-status-ready'}">
              ${item.status === 'done' ? 'Selesai' : 'Siap'}
            </span>
          </div>
          <button type="button" class="batch-item-btn" title="Hapus foto ini">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        `;

        card.addEventListener('click', (e) => {
          if (!e.target.closest('.batch-item-btn')) {
            this.selectQueueItem(idx);
          }
        });

        card.querySelector('.batch-item-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          this.removeItem(idx);
        });

        this.dom.batchGrid.appendChild(card);
      });
    }

    selectQueueItem(index) {
      if (index < 0 || index >= this.queue.length) return;
      this.currentIndex = index;
      const item = this.queue[index];

      this.dom.currentFileName.textContent = item.name;
      this.updateDimensionsInfo();

      const previewSrc = item.enhancedUrl || item.originalUrl;
      this.viewer.setImages(item.originalUrl, previewSrc, item.width, item.height);

      if (!item.enhancedCanvas) {
        this.processCurrentItem();
      } else {
        this.latestEnhancedBlob = item.enhancedBlob;
        this.latestEnhancedUrl = item.enhancedUrl;
      }

      this.renderBatchGrid();
    }

    removeItem(index) {
      const removed = this.queue.splice(index, 1)[0];
      if (removed) {
        if (removed.originalUrl) URL.revokeObjectURL(removed.originalUrl);
        if (removed.enhancedUrl) URL.revokeObjectURL(removed.enhancedUrl);
      }
      if (this.currentIndex >= this.queue.length) {
        this.currentIndex = Math.max(0, this.queue.length - 1);
      }
      this.updateQueueUI();
      if (this.queue.length > 0) {
        this.selectQueueItem(this.currentIndex);
      }
    }

    resetAll() {
      this.queue.forEach(item => {
        if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
        if (item.enhancedUrl) URL.revokeObjectURL(item.enhancedUrl);
      });
      this.queue = [];
      this.currentIndex = 0;
      this.latestEnhancedBlob = null;
      this.latestEnhancedUrl = null;
      this.updateQueueUI();
      this.showToast('Semua foto telah dibersihkan', 'info');
    }

    updateDimensionsInfo() {
      const item = this.queue[this.currentIndex];
      if (!item) return;

      const targetW = Math.round(item.width * this.currentScale);
      const targetH = Math.round(item.height * this.currentScale);

      this.dom.origDimBadge.textContent = `Asli: ${item.width} x ${item.height} px`;
      this.dom.targetDimBadge.textContent = `Hasil: ${targetW} x ${targetH} px`;
      this.dom.scaleRatioBadge.textContent = `Skala ${this.currentScale}x`;
    }

    autoTriggerProcess() {
      // Debounced trigger when sliders or scale change
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.processCurrentItem();
      }, 250);
    }

    getProcessingParams() {
      return {
        cas: parseInt(this.dom.sliderCas.value, 10),
        denoise: parseInt(this.dom.sliderDenoise.value, 10),
        texture: parseInt(this.dom.sliderTexture.value, 10),
        edge: parseInt(this.dom.sliderEdge.value, 10)
      };
    }

    getSelectedEngine() {
      let selected = 'espcn';
      this.dom.engineRadios.forEach(r => {
        if (r.checked) selected = r.value;
      });
      return selected;
    }

    getSelectedFormat() {
      let format = 'png';
      this.dom.formatRadios.forEach(r => {
        if (r.checked) format = r.value;
      });
      return format;
    }

    async processCurrentItem() {
      const item = this.queue[this.currentIndex];
      if (!item || this.isProcessing) return;

      this.isProcessing = true;
      this.showProgress();

      const params = this.getProcessingParams();
      const engine = this.getSelectedEngine();

      try {
        const enhancedCanvas = await this.pipeline.process(
          item.imgElement,
          this.currentScale,
          params,
          engine,
          (percent, msg) => {
            this.dom.progressBarFill.style.width = `${percent}%`;
            this.dom.progressPercent.textContent = `${percent}%`;
            this.dom.progressSubtitle.textContent = msg;
          }
        );

        // Convert canvas to export blob
        const format = this.getSelectedFormat();
        const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
        const quality = format === 'jpeg' ? parseInt(this.dom.sliderJpegQ.value, 10) / 100 : 0.95;

        const blob = await new Promise((res) => {
          enhancedCanvas.toBlob(res, mimeType, quality);
        });

        if (item.enhancedUrl) URL.revokeObjectURL(item.enhancedUrl);
        const url = URL.createObjectURL(blob);

        item.enhancedCanvas = enhancedCanvas;
        item.enhancedBlob = blob;
        item.enhancedUrl = url;
        item.status = 'done';

        this.latestEnhancedBlob = blob;
        this.latestEnhancedUrl = url;

        this.viewer.setImages(item.originalUrl, url, enhancedCanvas.width, enhancedCanvas.height);
        this.updateDimensionsInfo();
        this.renderBatchGrid();
        this.dom.mobileStatusText.textContent = 'Siap Diunduh';

        this.hideProgress();
        this.showToast('Rekonstruksi pixel selesai!', 'success');
      } catch (err) {
        this.hideProgress();
        if (err.message !== 'PROSES_DIBATALKAN') {
          console.error(err);
          this.showToast('Gagal memproses gambar: ' + err.message, 'error');
        }
      } finally {
        this.isProcessing = false;
      }
    }

    async processAllBatch() {
      if (this.queue.length === 0 || this.isProcessing) return;
      this.showToast('Memulai pemrosesan batch...', 'info');

      for (let i = 0; i < this.queue.length; i++) {
        this.selectQueueItem(i);
        await this.processCurrentItem();
      }

      this.showToast('Semua foto batch selesai diproses!', 'success');
    }

    async downloadCurrentItem() {
      const item = this.queue[this.currentIndex];
      if (!item || !item.enhancedBlob) {
        await this.processCurrentItem();
      }
      if (!item.enhancedBlob) return;

      const format = this.getSelectedFormat();
      const ext = format === 'jpeg' ? 'jpg' : format;
      const baseName = item.name.replace(/\.[^/.]+$/, '');
      const downloadName = `${baseName}_enhanced_${this.currentScale}x.${ext}`;

      const a = document.createElement('a');
      a.href = item.enhancedUrl;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      this.showToast(`Mengunduh ${downloadName}`, 'success');
    }

    async copyToClipboard() {
      const item = this.queue[this.currentIndex];
      if (!item || !item.enhancedCanvas) {
        this.showToast('Harap tunggu foto selesai diproses', 'info');
        return;
      }

      try {
        if (!navigator.clipboard || !window.ClipboardItem) {
          this.showToast('Clipboard API tidak didukung di browser ini', 'error');
          return;
        }

        // Clipboard strictly requires image/png
        const pngBlob = await new Promise(r => item.enhancedCanvas.toBlob(r, 'image/png'));
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': pngBlob })
        ]);
        this.showToast('Gambar resolusi tinggi berhasil disalin ke clipboard!', 'success');
      } catch (err) {
        console.error(err);
        this.showToast('Gagal menyalin ke clipboard', 'error');
      }
    }

    async downloadBatchZip() {
      if (this.queue.length === 0) return;
      if (typeof JSZip === 'undefined') {
        this.showToast('Library JSZip belum siap', 'error');
        return;
      }

      this.showProgress();
      this.dom.progressStageTitle.textContent = 'Menyiapkan Paket ZIP...';

      const zip = new JSZip();
      const usedNames = new Set();
      const format = this.getSelectedFormat();
      const ext = format === 'jpeg' ? 'jpg' : format;

      let processedCount = 0;
      for (let i = 0; i < this.queue.length; i++) {
        const item = this.queue[i];
        if (!item.enhancedBlob) {
          this.selectQueueItem(i);
          await this.processCurrentItem();
        }

        const baseName = item.name.replace(/\.[^/.]+$/, '');
        let targetName = `${baseName}_enhanced_${this.currentScale}x.${ext}`;
        let suffix = 2;
        while (usedNames.has(targetName)) {
          targetName = `${baseName}_enhanced_${this.currentScale}x_${suffix}.${ext}`;
          suffix++;
        }
        usedNames.add(targetName);

        zip.file(targetName, item.enhancedBlob);
        processedCount++;
        const p = Math.round((processedCount / this.queue.length) * 100);
        this.dom.progressBarFill.style.width = `${p}%`;
        this.dom.progressPercent.textContent = `${p}%`;
        this.dom.progressSubtitle.textContent = `Menambahkan ${targetName} ke ZIP (${processedCount}/${this.queue.length})`;
        await new Promise(r => setTimeout(r, 2));
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        this.dom.progressBarFill.style.width = `${Math.round(metadata.percent)}%`;
        this.dom.progressPercent.textContent = `${Math.round(metadata.percent)}%`;
        this.dom.progressSubtitle.textContent = `Mengompresi arsip ZIP...`;
      });

      const zipUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = `OptiPixel_Batch_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      this.hideProgress();
      this.showToast('Arsip ZIP berhasil diunduh!', 'success');
    }

    showProgress() {
      this.dom.progressOverlay.style.display = 'flex';
      this.dom.progressBarFill.style.width = '0%';
      this.dom.progressPercent.textContent = '0%';
    }

    hideProgress() {
      this.dom.progressOverlay.style.display = 'none';
    }

    showToast(message, type = 'info') {
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      
      const iconSvg = type === 'success' 
        ? `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`
        : type === 'error'
        ? `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`
        : `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;

      toast.innerHTML = `${iconSvg}<span>${message}</span>`;
      this.dom.toastContainer.appendChild(toast);

      setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 250);
      }, 3500);
    }

    toggleTheme() {
      if (document.body.classList.contains('theme-dark')) {
        document.body.classList.replace('theme-dark', 'theme-light');
        localStorage.setItem('optipixel-theme', 'light');
      } else {
        document.body.classList.replace('theme-light', 'theme-dark');
        localStorage.setItem('optipixel-theme', 'dark');
      }
    }

    registerServiceWorker() {
      // Saved theme restore
      const savedTheme = localStorage.getItem('optipixel-theme');
      if (savedTheme === 'light') {
        document.body.classList.replace('theme-dark', 'theme-light');
      }

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(err => {
          console.warn('SW registration failed:', err);
        });
      }
    }
  }

  // --- Bootstrap on DOM Ready ---
  document.addEventListener('DOMContentLoaded', () => {
    window.optiPixel = new App();

    // Sembunyikan dan hapus paksa Netlify Drawer widget jika diinjeksikan
    const removeNetlifyWidgets = () => {
      const selectors = [
        'netlify-drawer', '#netlify-drawer', '.netlify-drawer',
        '[data-netlify-drawer]', 'div[class*="netlify-drawer"]',
        'iframe[src*="netlify"]', 'div[id*="netlify-feedback"]',
        'div[class*="netlify-feedback"]', '.feedback-widget',
        '[aria-label="Netlify Drawer"]'
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
      });
    };

    removeNetlifyWidgets();
    setInterval(removeNetlifyWidgets, 800);
  });
})();
