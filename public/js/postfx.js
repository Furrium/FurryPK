/**
 * postfx.js v5 — 强化版 + 可调参数
 * ============================================================
 * v4 已跑通（3D 正常 + bloom 生效），但用户反馈"和原版区别有点小"。
 *
 * 原因分析（两层）：
 *   ① 参数太保守：threshold=0.85 只有极亮的东西才泛光，你的场景
 *      大多数材质 emissive 强度不足 → 几乎没东西越过阈值
 *   ② 结构问题：只有 bloom 一层。samsy 那种质感其实是「多层叠加」：
 *      bloom + 色彩分级 + 暗角 + 对比度 + 曝光
 *
 * v5 改动：
 *   - bloom 阈值大幅下调（让霓虹/自发光真正发光）
 *   - 新增「调色 Pass」：对比度 / 饱和度 / 暗角 / 轻微色偏
 *   - URL 参数实时调参：?fx=1&bloom=1.2&thr=0.5&vig=0.5&con=1.15
 */
(function (global) {
  'use strict';
  var T = global.THREE;

  // 三档预设：现在 bloom 阈值明显降低
  var PRESETS = {
    high: { strength: 0.10, radius: 0.55, threshold: 0.45, exposure: 0.95, contrast: 1.10, saturation: 1.10, vignette: 0.34 },
    mid:  { strength: 0.10, radius: 0.45, threshold: 0.55, exposure: 0.90, contrast: 1.08, saturation: 1.08, vignette: 0.28 },
    low:  { strength: 0.08, radius: 0.35, threshold: 0.68, exposure: 0.85, contrast: 1.06, saturation: 1.06, vignette: 0.22 },
  };

  function q(name) {
    try { return new URLSearchParams(global.location.search).get(name); } catch (e) { return null; }
  }
  function qf(name, dflt) {
    var v = q(name);
    if (v === null) return dflt;
    var n = parseFloat(v);
    return isNaN(n) ? dflt : n;
  }
  function urlFlag(name, dflt) {
    var v = q(name);
    if (v === null) return dflt;
    return v !== '0' && v !== 'false';
  }

  function create(renderer, scene, camera, opts) {
    opts = opts || {};
    var enabled = urlFlag('fx', true);
    var api = {
      enabled: false, level: 'off',
      _frames: 0, _slow: 0,
      _baseExposure: renderer.toneMappingExposure,
      stats: { renders: 0 },
    };
    function plain() { renderer.render(scene, camera); }

    if (!enabled) {
      console.log('[postfx] ?fx=0 → 关闭');
      api.render = plain; return api;
    }

    var need = ['EffectComposer', 'UnrealBloomPass', 'CopyShader', 'LuminosityHighPassShader', 'FullScreenQuad', 'Pass'];
    var missing = need.filter(function (n) { return !T[n]; });
    if (missing.length) {
      console.warn('[postfx] 缺依赖:', missing.join(', '));
      api.render = plain; return api;
    }

    var lvl = opts.level;
    if (!lvl || !PRESETS[lvl]) {
      var dpr = global.devicePixelRatio || 1;
      var mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
      lvl = mobile ? (dpr > 2 ? 'low' : 'mid') : (dpr > 1.5 ? 'mid' : 'high');
    }
    var P = Object.assign({}, PRESETS[lvl]);

    // URL 覆盖
    P.strength   = qf('bloom', P.strength);
    P.radius     = qf('rad',   P.radius);
    P.threshold  = qf('thr',   P.threshold);
    P.exposure   = qf('exp',   P.exposure);
    P.contrast   = qf('con',   P.contrast);
    P.saturation = qf('sat',   P.saturation);
    P.vignette   = qf('vig',   P.vignette);
    api.level = lvl;

    var s0 = new T.Vector2();
    renderer.getDrawingBufferSize ? renderer.getDrawingBufferSize(s0) : renderer.getSize(s0);
    if (s0.x < 1) s0.set(1, 1);

    var rt = new T.WebGLRenderTarget(s0.x, s0.y, {
      minFilter: T.LinearFilter, magFilter: T.LinearFilter,
      format: T.RGBAFormat, type: T.UnsignedByteType,
      encoding: T.sRGBEncoding,
      depthBuffer: true, stencilBuffer: false,
    });

    var composer = new T.EffectComposer(renderer);
    composer.setSize(s0.x, s0.y);

    // ---- Pass 1: 注入（把 rt.texture 写进 composer）----
    class InjectPass extends T.Pass {
      constructor(texture, material) {
        super();
        this.texture = texture; this.material = material;
        this.fsQuad = new T.FullScreenQuad(material);
        this.needsSwap = true;
      }
      render(renderer, writeBuffer) {
        this.material.uniforms.tDiffuse.value = this.texture;
        var target = this.renderToScreen ? null : writeBuffer;
        renderer.setRenderTarget(target);
        renderer.clear(true, true, false);
        this.fsQuad.render(renderer);
      }
    }

    var injectMat = new T.ShaderMaterial({
      uniforms: { tDiffuse: { value: rt.texture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }',
      depthTest: false, depthWrite: false,
    });
    composer.addPass(new InjectPass(rt.texture, injectMat));

    // ---- Pass 2: Bloom ----
    var bloom = new T.UnrealBloomPass(new T.Vector2(s0.x, s0.y), P.strength, P.radius, P.threshold);
    composer.addPass(bloom);

    // ---- Pass 3: 调色（对比度/饱和度/暗角）----
    var gradeMat = new T.ShaderMaterial({
      uniforms: {
        tDiffuse:   { value: null },
        uContrast:  { value: P.contrast },
        uSaturation:{ value: P.saturation },
        uVignette:  { value: P.vignette },
        uTint:      { value: new T.Vector3(0.92, 0.98, 1.10) },  // 轻微冷色偏（贴合青蓝基调）
        uTintAmt:   { value: 0.35 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: [
        'uniform sampler2D tDiffuse;',
        'uniform float uContrast, uSaturation, uVignette, uTintAmt;',
        'uniform vec3 uTint;',
        'varying vec2 vUv;',
        'void main(){',
        '  vec4 c = texture2D(tDiffuse, vUv);',
        '  vec3 col = c.rgb;',
        // 对比度
        '  col = (col - 0.5) * uContrast + 0.5;',
        // 饱和度
        '  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));',
        '  col = mix(vec3(lum), col, uSaturation);',
        // 冷色偏
        '  col = mix(col, col * uTint, uTintAmt);',
        // 暗角
        '  vec2 d = vUv - 0.5;',
        '  float v = 1.0 - dot(d, d) * uVignette * 2.2;',
        '  col *= clamp(v, 0.0, 1.0);',
        '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);',
        '}',
      ].join('\n'),
      depthTest: false, depthWrite: false,
    });
    var gradePass = new T.ShaderPass(gradeMat);
    composer.addPass(gradePass);

    composer.passes[composer.passes.length - 1].renderToScreen = true;

    api.rt = rt; api.composer = composer; api.bloomPass = bloom; api.gradePass = gradePass;
    api.enabled = true;
    renderer.toneMappingExposure = P.exposure;

    console.log('[postfx v5] 档位=' + lvl +
      ' bloom(' + P.strength.toFixed(2) + '/' + P.radius.toFixed(2) + '/' + P.threshold.toFixed(2) + ')' +
      ' exp=' + P.exposure.toFixed(2) + ' con=' + P.contrast.toFixed(2) +
      ' sat=' + P.saturation.toFixed(2) + ' vig=' + P.vignette.toFixed(2));

    api.render = function (dt, drawScene) {
      if (!api.enabled) { (drawScene || plain)(); return; }
      dt = dt || 0.016;
      api.stats.renders++;
      var prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, false);
      if (drawScene) drawScene(); else renderer.render(scene, camera);
      renderer.setRenderTarget(prev);
      composer.render(dt);
      api.tick(dt);
    };

    api.tick = function (dt) {
      api._frames++;
      if (dt > 0.033) api._slow++;
      if (api._frames < 150) return;
      var r = api._slow / api._frames;
      if (r > 0.5) {
        if (api.level === 'high') { api.setLevel('mid'); console.log('[postfx] 掉帧 → mid'); }
        else if (api.level === 'mid') { api.setLevel('low'); console.log('[postfx] 掉帧 → low'); }
        else if (api.level === 'low' && r > 0.8) { api.disable(); console.log('[postfx] 掉帧 → 关闭'); }
      }
      api._frames = 0; api._slow = 0;
    };

    api.setLevel = function (l) {
      var p = PRESETS[l]; if (!p) return;
      api.level = l;
      bloom.strength = p.strength; bloom.radius = p.radius; bloom.threshold = p.threshold;
      gradeMat.uniforms.uContrast.value = p.contrast;
      gradeMat.uniforms.uSaturation.value = p.saturation;
      gradeMat.uniforms.uVignette.value = p.vignette;
      renderer.toneMappingExposure = p.exposure;
    };

    api.setParams = function (o) {
      o = o || {};
      if (o.bloom !== undefined) bloom.strength = o.bloom;
      if (o.radius !== undefined) bloom.radius = o.radius;
      if (o.threshold !== undefined) bloom.threshold = o.threshold;
      if (o.exposure !== undefined) renderer.toneMappingExposure = o.exposure;
      if (o.contrast !== undefined) gradeMat.uniforms.uContrast.value = o.contrast;
      if (o.saturation !== undefined) gradeMat.uniforms.uSaturation.value = o.saturation;
      if (o.vignette !== undefined) gradeMat.uniforms.uVignette.value = o.vignette;
      console.log('[postfx] 参数已更新:', JSON.stringify(o));
    };

    api.disable = function () { api.enabled = false; api.level = 'off'; renderer.toneMappingExposure = api._baseExposure; };
    api.enable = function () { api.enabled = true; if (api.level === 'off') api.setLevel('mid'); };

    api.resize = function () {
      var s = new T.Vector2();
      renderer.getDrawingBufferSize ? renderer.getDrawingBufferSize(s) : renderer.getSize(s);
      if (s.x < 1 || s.y < 1) return;
      rt.setSize(s.x, s.y);
      composer.setSize(s.x, s.y);
      bloom.setSize(new T.Vector2(s.x, s.y));
    };

    api.debugState = function () {
      return {
        enabled: api.enabled, level: api.level, renders: api.stats.renders,
        rt: rt.width + 'x' + rt.height, passes: composer.passes.length,
        bloom: bloom.strength.toFixed(2), thr: bloom.threshold.toFixed(2),
        con: gradeMat.uniforms.uContrast.value.toFixed(2),
        sat: gradeMat.uniforms.uSaturation.value.toFixed(2),
        vig: gradeMat.uniforms.uVignette.value.toFixed(2),
        exposure: renderer.toneMappingExposure.toFixed(2),
      };
    };

    return api;
  }

  global.PostFX = { create: create, PRESETS: PRESETS };
})(window);
