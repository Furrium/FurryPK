/**
 * ground-mirror.js — 带模糊的镜面地面（替代纯 Reflector）
 * ============================================================
 * 问题：three.js 原版 Reflector 是「清晰镜面」。
 *       靠降 mres 只会得到马赛克，不是虚化。
 *
 * 方案：替换 Reflector 的 fragmentShader，在采样时做
 *       ① 9-tap 高斯模糊（可调半径）
 *       ② 可选的垂直方向额外偏移（模拟地表微观不平）
 *       ③ 距离衰减（远处更模糊 —— 接近真实湿地面）
 *
 * 关键点：模糊在【采样时】做，不额外增加渲染 pass，性能几乎无额外开销。
 */
(function (global) {
  'use strict';
  var T = global.THREE;

  function q(n) { try { return new URLSearchParams(global.location.search).get(n); } catch (e) { return null; } }
  function qf(n, d) { var v = q(n); if (v === null) return d; var x = parseFloat(v); return isNaN(x) ? d : x; }
  function urlFlag(n, d) { var v = q(n); if (v === null) return d; return v !== '0' && v !== 'false'; }

  /**
   * 构造带模糊的 Reflector shader
   * @param {number} blurRadius  模糊半径（0 = 清晰，1~4 常见）
   * @param {number} tint        反射亮度（0~1）
   * @param {number} mirrorMix   ⭐ 反射率（0=看不到反射，1=纯镜面）
   * @param {number} baseColor   ⭐ 地面本色（反射不足处透出的底色）
   */
  function makeBlurShader(blurRadius, tint, mirrorMix, baseColor) {
    var R = blurRadius;

    return {
      uniforms: {
        color: { value: null },          // Reflector 会覆盖
        tDiffuse: { value: null },       // Reflector 会覆盖
        textureMatrix: { value: null },  // Reflector 会覆盖
        uBlur: { value: R },             // 模糊半径
        uTint: { value: tint },          // 反射亮度
        uMix: { value: mirrorMix },      // ⭐ 反射率（0=纯黑地面，1=全镜面）
        uBase: { value: new T.Color(baseColor) },  // ⭐ 地面本色（反射不足处透出的颜色）
        uTexel: { value: new T.Vector2(1 / 512, 1 / 512) },
        uDistBlur: { value: 1.0 },
      },

      vertexShader: [
        'uniform mat4 textureMatrix;',
        'varying vec4 vUv;',
        'void main() {',
        '  vUv = textureMatrix * vec4( position, 1.0 );',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );',
        '}',
      ].join('\n'),

      fragmentShader: [
        'uniform vec3 color;',
        'uniform sampler2D tDiffuse;',
        'uniform float uBlur;',
        'uniform float uTint;',
        'uniform float uMix;',
        'uniform vec3  uBase;',
        'uniform vec2  uTexel;',
        'uniform float uDistBlur;',
        'varying vec4 vUv;',

        // 色调混合（保留原版行为，用于给反射染色）
        'float blendOverlay( float base, float blend ) {',
        '  return( base < 0.5 ? ( 2.0 * base * blend ) : ( 1.0 - 2.0 * ( 1.0 - base ) * ( 1.0 - blend ) ) );',
        '}',
        'vec3 blendOverlay( vec3 base, vec3 blend ) {',
        '  return vec3( blendOverlay( base.r, blend.r ), blendOverlay( base.g, blend.g ), blendOverlay( base.b, blend.b ) );',
        '}',

        // ⭐ 把「反射」与「地面本色」按 uMix 混合，并做亮度压制
        //    refl: 采样到的反射色（已模糊）
        //    out  = base*(1-mix) + refl*tint*mix
        //    mix=0 → 纯地面本色（看不到反射）
        //    mix=1 → 纯反射（真镜面）
        'vec3 composeMirror( vec3 refl ) {',
        '  vec3 tinted = blendOverlay( refl, color ) * uTint;',
        '  vec3 outc = mix( uBase, tinted, clamp( uMix, 0.0, 1.0 ) );',
        '  return outc;',
        '}',

        'void main() {',
        '  vec2 uv = vUv.xy / vUv.w;',

        // 距离越远，模糊越强（近处清晰、远处糊 —— 像真实湿地面）
        '  float d = length( uv - 0.5 );',
        '  float radius = uBlur * ( 1.0 + d * uDistBlur );',

        // ⭐ 距离衰减：越远反射越弱（真实地面边缘反射通常更淡）
        '  float mixK = clamp( uMix * ( 1.0 - d * 0.55 ), 0.0, 1.0 );',
        '  vec3 base = vec3( 0.0 );',

        '  if ( radius < 0.0005 ) {',
        '    base = texture2DProj( tDiffuse, vUv ).rgb;',
        '  } else {',
        // 9-tap 高斯：中心权重高，外围递减（权重和 = 1）
        '    vec2 o = uTexel * radius;',
        '    base += texture2DProj( tDiffuse, vUv ).rgb * 0.25;',
        '    base += texture2DProj( tDiffuse, vUv + vec4( o.x,  0.0, 0.0, 0.0 ) ).rgb * 0.125;',
        '    base += texture2DProj( tDiffuse, vUv + vec4(-o.x,  0.0, 0.0, 0.0 ) ).rgb * 0.125;',
        '    base += texture2DProj( tDiffuse, vUv + vec4( 0.0,  o.y, 0.0, 0.0 ) ).rgb * 0.125;',
        '    base += texture2DProj( tDiffuse, vUv + vec4( 0.0, -o.y, 0.0, 0.0 ) ).rgb * 0.125;',
        '    base += texture2DProj( tDiffuse, vUv + vec4( o.x,  o.y, 0.0, 0.0 ) ).rgb * 0.0625;',
        '    base += texture2DProj( tDiffuse, vUv + vec4(-o.x,  o.y, 0.0, 0.0 ) ).rgb * 0.0625;',
        '    base += texture2DProj( tDiffuse, vUv + vec4( o.x, -o.y, 0.0, 0.0 ) ).rgb * 0.0625;',
        '    base += texture2DProj( tDiffuse, vUv + vec4(-o.x, -o.y, 0.0, 0.0 ) ).rgb * 0.0625;',
        '  }',

        '  vec3 tinted = blendOverlay( base, color ) * uTint;',
        '  vec3 outc = mix( uBase, tinted, mixK );',
        '  gl_FragColor = vec4( clamp( outc, 0.0, 1.0 ), 1.0 );',
        '}',
      ].join('\n'),
    };
  }

  /**
   * 创建带模糊的镜面
   * @param {number} size      平面边长
   * @param {object} opt       { res, blur, tint, distBlur, color }
   */
  function create(size, opt) {
    opt = opt || {};
    if (!T.Reflector) { console.warn('[gmirror] 缺少 Reflector'); return null; }

    var res      = opt.res      !== undefined ? opt.res      : Math.max(128, Math.min(2048, qf('mres', 512)));
    var blur     = opt.blur     !== undefined ? opt.blur     : qf('mblur', 2.0);
    var tint     = opt.tint     !== undefined ? opt.tint     : qf('mtint', 0.55);
    var distBlur = opt.distBlur !== undefined ? opt.distBlur : qf('mdist', 1.4);
    // ⭐ 反射率：默认 0.45（不足一半），避免"站在玻璃上"的怪异感
    var mixAmt   = opt.mix      !== undefined ? opt.mix      : qf('mmix', 0.45);
    // ⭐ 地面本色：反射不足处透出的底色（深蓝黑，贴合场景基调）
    var baseCol  = opt.base     !== undefined ? opt.base     : (q('mbase') ? '#' + q('mbase') : '#0a0f18');
    var color    = opt.color    !== undefined ? opt.color    : 0x8899aa;

    var shader = makeBlurShader(blur, tint, mixAmt, baseCol);
    shader.uniforms.uTexel.value = new T.Vector2(1 / res, 1 / res);

    var geo = new T.PlaneGeometry(size, size);
    var mir = new T.Reflector(geo, {
      clipBias: 0.003,
      textureWidth: res,
      textureHeight: res,
      color: color,
      shader: shader,
    });

    mir.userData.blurUniforms = shader.uniforms;
    mir.userData.blurInfo = {
      res: res, blur: blur, tint: tint, distBlur: distBlur,
      mix: mixAmt, base: baseCol,
    };

    console.log('[gmirror] 模糊镜面 res=' + res + ' blur=' + blur +
      ' tint=' + tint + ' mix=' + mixAmt + ' base=' + baseCol + ' distBlur=' + distBlur);

    mir.setBlur = function (v) { shader.uniforms.uBlur.value = v; };
    mir.setTint = function (v) { shader.uniforms.uTint.value = v; };
    mir.setDistBlur = function (v) { shader.uniforms.uDistBlur.value = v; };
    mir.setMix = function (v) { shader.uniforms.uMix.value = v; };            // ⭐ 反射率
    mir.setBase = function (hex) { shader.uniforms.uBase.value.set(hex); };   // ⭐ 地面本色

    return mir;
  }

  global.GroundMirror = { create: create, makeBlurShader: makeBlurShader };
})(window);
