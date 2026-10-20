// fx_depth.js — automatic scene-depth capture for soft particles.
//
// When the first FX transparent mesh is about to be drawn (onBeforeRender), all opaque geometry of the current
// render() call is already in the bound framebuffer's depth buffer. We blit that depth buffer (MSAA resolve
// included) into our own depth texture, which the particle shaders then sample — no extra scene pass and no work
// for the engine. Works for the default framebuffer and for any WebGLRenderTarget (EffectComposer RenderPass).
// If the blit fails once (format mismatch on an exotic setup) it disables itself and FX fall back to
// geometric soft-fading. An engine may also provide its own depth texture via FX.setDepthTexture().
import * as THREE from 'three';

export class DepthGrabber {
  constructor(renderer) {
    this.renderer = renderer;
    const gl = (this.gl = renderer.getContext());
    this.enabled = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    this.texture = new THREE.Texture();           // three wrapper around our raw GL texture
    this.texture.isFXDepth = true;
    this.glTex = null; this.fb = null; this.w = 0; this.h = 0; this.fmt = 0;
    this.lastFB = undefined; this.lastFmt = 0; this.checked = false;
    this.lastFrame = -1; this.lastRenderCall = -1; this.valid = false;
    this._size = new THREE.Vector2();
    this.fixes = new Map();   // framebuffer → depth format that actually blits
  }

  _queryFormat(fb) {
    const gl = this.gl;
    const target = gl.DRAW_FRAMEBUFFER;
    const dAtt = fb ? gl.DEPTH_ATTACHMENT : gl.DEPTH, sAtt = fb ? gl.STENCIL_ATTACHMENT : gl.STENCIL;
    let type = gl.getFramebufferAttachmentParameter(target, dAtt, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
    if (!type) { // maybe a DEPTH_STENCIL attachment only reported there
      if (fb) type = gl.getFramebufferAttachmentParameter(target, gl.DEPTH_STENCIL_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
      if (!type) return 0;
    }
    const dbits = gl.getFramebufferAttachmentParameter(target, dAtt, gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE);
    const comp = gl.getFramebufferAttachmentParameter(target, dAtt, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE);
    let sbits = 0;
    const stype = gl.getFramebufferAttachmentParameter(target, sAtt, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
    if (stype) sbits = gl.getFramebufferAttachmentParameter(target, sAtt, gl.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE);
    if (comp === gl.FLOAT) return sbits ? gl.DEPTH32F_STENCIL8 : gl.DEPTH_COMPONENT32F;
    if (dbits === 16 && !sbits) return gl.DEPTH_COMPONENT16;
    if (dbits === 0) return 0;
    // browsers usually back the default framebuffer with packed depth-stencil even when stencil:false
    if (!fb) return gl.DEPTH24_STENCIL8;
    return sbits ? gl.DEPTH24_STENCIL8 : gl.DEPTH_COMPONENT24;
  }

  _alloc(fmt, w, h) {
    const gl = this.gl, state = this.renderer.state;
    if (this.glTex) gl.deleteTexture(this.glTex);
    if (!this.fb) this.fb = gl.createFramebuffer();
    this.glTex = gl.createTexture();
    state.bindTexture(gl.TEXTURE_2D, this.glTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
    state.unbindTexture();
    const att = (fmt === gl.DEPTH24_STENCIL8 || fmt === gl.DEPTH32F_STENCIL8) ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
    const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, att, gl.TEXTURE_2D, this.glTex, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
    // hand the raw texture to three (version stays 0 → three just binds __webglTexture)
    const props = this.renderer.properties.get(this.texture);
    props.__webglTexture = this.glTex; props.__webglInit = true;
    this.fmt = fmt; this.w = w; this.h = h;
  }

  // Called from onBeforeRender of the first FX transparent mesh. Returns true if a valid depth texture is ready.
  grab() {
    if (!this.enabled) return false;
    const r = this.renderer, gl = this.gl;
    const call = r.info.render.frame;              // increments once per renderer.render()
    if (call === this.lastRenderCall) return this.valid;
    this.lastRenderCall = call;
    const rt = r.getRenderTarget();
    let w, h;
    if (rt) { w = rt.width; h = rt.height; } else { r.getDrawingBufferSize(this._size); w = this._size.x; h = this._size.y; }
    const drawFB = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const readFB = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    let fmt = this.lastFmt;
    if (drawFB !== this.lastFB) { fmt = this.fixes.has(drawFB) ? this.fixes.get(drawFB) : this._queryFormat(drawFB); this.lastFB = drawFB; this.lastFmt = fmt; }
    if (!fmt) { this.valid = false; return false; }
    if (!this.checked) for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) { /* flush unrelated pending errors once */ }
    if (fmt !== this.fmt || w !== this.w || h !== this.h) this._alloc(fmt, w, h);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, drawFB);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fb);
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    if (!this.checked) {
      // The default framebuffer may report its depth format imprecisely (e.g. packed depth-stencil although
      // stencil:false was requested) — try the alternative packing once before giving up.
      let err = gl.getError();
      if (err !== gl.NO_ERROR) {
        const alt = fmt === gl.DEPTH_COMPONENT24 ? gl.DEPTH24_STENCIL8 : fmt === gl.DEPTH24_STENCIL8 ? gl.DEPTH_COMPONENT24
          : fmt === gl.DEPTH_COMPONENT32F ? gl.DEPTH32F_STENCIL8 : fmt === gl.DEPTH32F_STENCIL8 ? gl.DEPTH_COMPONENT32F : 0;
        if (alt) {
          this._alloc(alt, w, h);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, drawFB); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fb);
          gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
          err = gl.getError();
          if (err === gl.NO_ERROR) { this.lastFmt = alt; this.fixes.set(drawFB, alt); }
        }
      }
      this.checked = true;
      if (err !== gl.NO_ERROR) {
        if (scissor) gl.enable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFB); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFB);
        console.warn('FX: automatic depth capture unavailable (GL error ' + err + '); using geometric soft fades.');
        this.enabled = false; this.valid = false; return false;
      }
    }
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFB);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFB);
    this.valid = true;
    return true;
  }

  dispose() {
    const gl = this.gl;
    if (this.glTex) gl.deleteTexture(this.glTex);
    if (this.fb) gl.deleteFramebuffer(this.fb);
    this.glTex = this.fb = null;
  }
}
