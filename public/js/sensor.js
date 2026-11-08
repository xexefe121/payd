// Physical tap ("bump") detection from the accelerometer.
//
// When two phones are knocked together, both register a sharp, short spike in
// linear acceleration within a few milliseconds of each other. We look for a
// high-magnitude, high-jerk sample that stands out from the recent baseline,
// and ignore continuous shaking (walking, waving the phone around).

export class TapSensor {
  constructor({ onTap, threshold = 13, jerk = 9, cooldownMs = 1400 } = {}) {
    this.onTap = onTap;
    this.threshold = threshold;
    this.jerk = jerk;
    this.cooldownMs = cooldownMs;
    this.active = false;
    this.last = 0;
    this.prevMag = 0;
    this.gravity = { x: 0, y: 0, z: 0 };
    this.recentSpikes = [];
    this.handler = (e) => this.sample(e);
  }

  static supported() {
    return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
  }

  static needsPermission() {
    return typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';
  }

  /** Must be called from a user gesture on iOS. */
  async start() {
    if (!TapSensor.supported()) return 'unsupported';
    if (TapSensor.needsPermission()) {
      try {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') return 'denied';
      } catch {
        return 'denied';
      }
    }
    window.addEventListener('devicemotion', this.handler);
    this.active = true;
    return 'on';
  }

  stop() {
    window.removeEventListener('devicemotion', this.handler);
    this.active = false;
  }

  sample(e) {
    let a = e.acceleration;
    if (!a || a.x === null) {
      // No linear acceleration available: high-pass filter the gravity-included signal.
      const g = e.accelerationIncludingGravity;
      if (!g || g.x === null) return;
      const k = 0.8;
      this.gravity.x = k * this.gravity.x + (1 - k) * g.x;
      this.gravity.y = k * this.gravity.y + (1 - k) * g.y;
      this.gravity.z = k * this.gravity.z + (1 - k) * g.z;
      a = { x: g.x - this.gravity.x, y: g.y - this.gravity.y, z: g.z - this.gravity.z };
    }
    const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    const jerk = mag - this.prevMag;
    this.prevMag = mag;
    const now = Date.now();

    if (mag > this.threshold * 0.6) this.recentSpikes.push(now);
    this.recentSpikes = this.recentSpikes.filter((t) => now - t < 1000);

    const isImpulse = mag > this.threshold && jerk > this.jerk;
    const shaking = this.recentSpikes.length > 6; // sustained motion, not a tap
    if (isImpulse && !shaking && now - this.last > this.cooldownMs) {
      this.last = now;
      this.onTap?.({ peak: Math.round(mag * 10) / 10, at: now });
    }
  }
}

export async function getGeo(timeout = 2500) {
  if (!('geolocation' in navigator)) return null;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeout);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(t);
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) });
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout },
    );
  });
}
