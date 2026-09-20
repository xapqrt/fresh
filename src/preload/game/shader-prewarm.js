"use strict";

/**
 * Compile and link one tiny program on the real game WebGL context before the
 * game starts creating its material variants. This pays ANGLE/Metal compiler
 * startup cost during canvas initialization rather than on the first fight.
 */
function prewarmWebGLContext(gl, webgl2 = false, now = () => performance.now()) {
  if (!gl || typeof gl.createShader !== "function") {
    return { ok: false, durationMs: 0, reason: "WebGL unavailable" };
  }

  const startedAt = now();
  let vertexShader = null;
  let fragmentShader = null;
  let program = null;
  try {
    const vertexSource = webgl2
      ? "#version 300 es\nin vec2 a_position;void main(){gl_Position=vec4(a_position,0.0,1.0);}"
      : "attribute vec2 a_position;void main(){gl_Position=vec4(a_position,0.0,1.0);}";
    const fragmentSource = webgl2
      ? "#version 300 es\nprecision mediump float;out vec4 color;void main(){color=vec4(0.0);}"
      : "precision mediump float;void main(){gl_FragColor=vec4(0.0);}";

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("createShader failed");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog?.(shader) || "shader compile failed";
        try { gl.deleteShader(shader); } catch (error) {}
        throw new Error(message);
      }
      return shader;
    };

    vertexShader = compile(gl.VERTEX_SHADER, vertexSource);
    fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
    program = gl.createProgram();
    if (!program) throw new Error("createProgram failed");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog?.(program) || "program link failed");
    }

    return {
      ok: true,
      durationMs: Math.round((now() - startedAt) * 1000) / 1000,
      webgl2: Boolean(webgl2),
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Math.round((now() - startedAt) * 1000) / 1000,
      reason: error?.message || String(error),
      webgl2: Boolean(webgl2),
    };
  } finally {
    try { if (program) gl.deleteProgram(program); } catch (error) {}
    try { if (vertexShader) gl.deleteShader(vertexShader); } catch (error) {}
    try { if (fragmentShader) gl.deleteShader(fragmentShader); } catch (error) {}
  }
}

module.exports = { prewarmWebGLContext };
