// Corniche car sound: a flat-plane V8, tyres, road and wind, synthesised per
// sample on the audio thread. Plain JavaScript because it is loaded as is by
// audioWorklet.addModule; the game posts its state about 60 times a second.
//
// Engine model, in the order sound travels:
//   firing events  - Ferrari F136, firing order 1-5-3-7-4-8-2-6, every 90° of
//                    crank, banks alternating: each bank alone fires evenly,
//                    which is what makes a flat-plane V8 scream instead of burble
//   blowdown pulse - shaped in crank angle, so it sharpens as revs rise
//   runners        - unequal lengths, a delay per cylinder (comb colour that
//                    moves with revs)
//   pipes          - one waveguide per bank, open-end reflection, an X-pipe
//   silencer       - resonances, and bypass valves that open on load at revs
//   radiation      - the open tail pipe is a high-pass
// Intake and valvetrain are separate layers, loud in the cockpit because the
// engine sits right behind the seats.

const TAU = Math.PI * 2;

class Biquad {
	constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
	set(type, f, q, gainDb = 0) {
		const w = TAU * Math.min(f, sampleRate * 0.45) / sampleRate;
		const cw = Math.cos(w), sw = Math.sin(w), alpha = sw / (2 * q);
		const A = Math.pow(10, gainDb / 40);
		let b0, b1, b2, a0, a1, a2;
		if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
		else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
		else if (type === 'bp') { b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
		else { b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; } // peak
		this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
		return this;
	}
	run(x) {
		// transposed direct form II: stays stable while coefficients glide
		const y = this.b0 * x + this.z1;
		this.z1 = this.b1 * x - this.a1 * y + this.z2;
		this.z2 = this.b2 * x - this.a2 * y;
		return y;
	}
}

class OnePole {
	constructor(f) { this.y = 0; this.setF(f); }
	setF(f) { this.k = 1 - Math.exp(-TAU * f / sampleRate); return this; }
	run(x) { return (this.y += (x - this.y) * this.k); }
}

class Delay {
	constructor(n) { this.buf = new Float32Array(n); this.i = 0; }
	push(x) { this.buf[this.i] = x; this.i = (this.i + 1) % this.buf.length; }
	/** Fractional read, `d` samples before the newest one. */
	read(d) {
		const n = this.buf.length;
		const base = Math.floor(d), f = d - base;
		const j = this.i - 1 - base;
		const a = this.buf[(j % n + n) % n], b = this.buf[((j - 1) % n + n) % n];
		return a + (b - a) * f;
	}
}

// deterministic noise so renders repeat exactly
let seed = 22222;
function rnd() {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
}
const white = () => rnd() * 2 - 1;

const C_GAS = 520; // speed of sound in hot exhaust, m/s

// cylinder: bank (0 = A, 1 = B), firing angle in the 720° cycle, runner length (m), strength
const FIRING = [1, 5, 3, 7, 4, 8, 2, 6];
const RUNNER = { 1: 0.52, 2: 0.47, 3: 0.43, 4: 0.5, 5: 0.49, 6: 0.44, 7: 0.53, 8: 0.46 };
const STRENGTH = { 1: 1.0, 2: 0.95, 3: 1.04, 4: 0.97, 5: 1.02, 6: 0.94, 7: 0.99, 8: 1.05 };

class Engine {
	constructor() {
		this.theta = 0;
		this.cyl = FIRING.map((n, k) => ({
			n, bank: n <= 4 ? 0 : 1, fire: k * (Math.PI / 2), runner: RUNNER[n], strength: STRENGTH[n],
			last: 0, amp: 0, jitter: 1,
		}));
		const pipe = (len) => ({ line: new Delay(2048), d: (2 * len / C_GAS) * sampleRate, lp: new OnePole(2600), y: 0 });
		this.pipes = [pipe(1.55), pipe(1.72)];
		this.tail = new Delay(4096);
		this.mufflerLow = new Biquad().set('peak', 95, 1.4, 7);
		this.mufflerMid = new Biquad().set('peak', 260, 2.2, 4);
		this.mufflerHigh = new Biquad().set('peak', 1350, 1.2, 3);
		this.valveLp = new Biquad().set('lp', 2200, 0.7);
		this.radiate = new Biquad().set('hp', 55, 0.7);
		this.dc = new Biquad().set('hp', 25, 0.7);
		this.intakeRes = new Biquad().set('bp', 410, 3.5);
		this.intakeNoise = new Biquad().set('bp', 900, 0.9);
		this.intakeLow = new Biquad().set('lp', 3200, 0.7);
		this.mechHp = new Biquad().set('hp', 2400, 0.7);
		this.whine = 0;
		this.valve = 0;
		this.limiterPhase = 0;
		this.popEnv = 0;
		this.bang = 0;
		this.lastRev = 0;
	}

	/** Filters that move with the valves, retuned once per block. */
	block() {
		this.valveLp.set('lp', 2100 + 5200 * this.valve, 0.7);
	}

	/**
	 * One sample. `rpm`, `load` 0..1 (fuel actually burnt), `throttle` 0..1 (air,
	 * for the intake), `cut` 1 while the ignition is cut, `limit` 1 on the limiter.
	 * Returns [exhaust, intake, mech].
	 */
	tick(rpm, load, throttle, cut, limit, shaftRpm, out) {
		// each firing kicks the crank a little faster: a flutter at firing frequency
		const omega = rpm * TAU / 60 * (1 + 0.006 * load * Math.sin(this.theta * 4));
		const dTheta = omega / sampleRate;
		this.theta += dTheta;
		if (this.theta >= 2 * TAU) this.theta -= 2 * TAU;
		// the limiter cuts fuel on whole revolutions, which is the stutter you hear
		const rev = this.theta < TAU ? 0 : 1;
		if (rev !== this.lastRev) {
			this.lastRev = rev;
			if (limit) this.limiterPhase = (this.limiterPhase + 1) % 3;
		}
		const burning = cut ? 0 : limit && this.limiterPhase !== 0 ? 0 : 1;
		// even a closed throttle burns a little: idle and overrun are never silent
		const fuel = burning * (0.12 + 0.88 * load);

		const banks = [0, 0];
		let intake = 0, mech = 0;
		const rise = 0.22, decay = 0.48 + 0.25 * (1 - load);
		for (const c of this.cyl) {
			// phase since this cylinder's exhaust valve opened, delayed by its runner
			let phi = this.theta - c.fire - omega * (c.runner / C_GAS);
			phi = ((phi % (2 * TAU)) + 2 * TAU) % (2 * TAU);
			if (phi < c.last) {
				// a new cycle for this cylinder: draw its strength for this firing
				c.amp = fuel * c.strength * (0.97 + 0.06 * rnd());
				c.jitter = 0.9 + 0.2 * rnd();
				if (!burning && rpm > 3200 && rnd() < 0.05 * (rpm / 9000) * (1 - throttle)) this.popEnv = 1;
			}
			c.last = phi;
			let p = 0;
			if (phi < rise) p = 0.5 - 0.5 * Math.cos(Math.PI * phi / rise);
			else if (phi < rise + 5 * decay) p = Math.exp(-(phi - rise) / (decay * c.jitter));
			if (p > 0) {
				// blowdown turbulence rides on the pressure front
				const edge = phi < rise * 2 ? 0.35 * white() : 0;
				banks[c.bank] += c.amp * (p + edge * p);
				if (phi < 0.06) mech += 0.25 * white();
			}
			// intake stroke is half a cycle later: a suction pulse
			let psi = phi - Math.PI;
			psi = ((psi % (2 * TAU)) + 2 * TAU) % (2 * TAU);
			if (psi < 0.9) intake -= Math.sin(Math.PI * psi / 0.9) * (0.25 + 0.75 * throttle);
		}

		// overrun pops and the upshift bang go straight into the pipes
		let pop = 0;
		if (this.popEnv > 0.001) {
			pop = this.popEnv * (0.6 * white() + 0.8) * 2.2;
			this.popEnv *= 0.993;
		}
		if (this.bang > 0.001) {
			pop += this.bang * (0.5 * white() + 1) * 3;
			this.bang *= 0.990;
		}

		// two pipes with an X: a little of each bank crosses to the other
		const x0 = banks[0] * 0.8 + banks[1] * 0.2 + pop * 0.5;
		const x1 = banks[1] * 0.8 + banks[0] * 0.2 + pop * 0.5;
		let ex = 0;
		const ins = [x0, x1];
		for (let b = 0; b < 2; b++) {
			const pp = this.pipes[b];
			const back = pp.lp.run(pp.line.read(pp.d));
			// open end reflects inverted and loses some energy each round trip
			const y = ins[b] - 0.62 * back;
			pp.line.push(y);
			ex += y;
		}
		// bypass valves open with load above about 4500 rpm: the 458 gets much louder and brighter
		const open = load > 0.35 && rpm > 4300 ? 1 : 0;
		this.valve += (open - this.valve) * 0.0006;
		ex = this.mufflerLow.run(ex);
		ex = this.mufflerMid.run(ex);
		ex = this.mufflerHigh.run(ex);
		ex = this.valveLp.run(ex);
		ex = this.radiate.run(this.dc.run(ex));
		ex *= 0.55 + 0.45 * this.valve;

		// intake: a pulse train through the airbox resonance plus roar
		const roar = this.intakeNoise.run(white()) * (0.1 + 0.9 * throttle) * Math.min(1, rpm / 7000);
		intake = this.intakeLow.run(this.intakeRes.run(intake) * 0.6 + roar * 0.5);

		// valvetrain ticks and a faint gear whine from the gearbox
		mech = this.mechHp.run(mech) * Math.min(1, rpm / 6000);
		this.whine += (shaftRpm * 31 / 60) * TAU / sampleRate;
		if (this.whine > TAU) this.whine -= TAU;
		mech += 0.04 * Math.sin(this.whine) * Math.min(1, shaftRpm / 4000);

		out[0] = ex;
		out[1] = intake;
		out[2] = mech;
	}
}

class Squeal {
	constructor() {
		this.bp = new Biquad().set('bp', 900, 14);
		this.bp2 = new Biquad().set('bp', 1800, 10);
		this.phase = 0;
		this.wobble = 0;
		this.level = 0;
		this.f = 900;
	}
	block(slide, n) {
		this.f = 820 + 260 * Math.tanh(slide / 8) + 120 * Math.sin(this.wobble);
		this.wobble += TAU * (5.5 + 3 * rnd()) * n / sampleRate;
		this.bp.set('bp', this.f, 14);
		this.bp2.set('bp', this.f * 2.02, 10);
	}
	tick(slide, load) {
		// rubber starts to sing past about a metre per second of sliding, saturating by ten
		const want = Math.min(1, Math.max(0, (slide - 0.8) / 7)) * Math.min(1.3, Math.sqrt(load / 4000));
		this.level += (want - this.level) * 0.002;
		if (this.level < 1e-4) return 0;
		const f = this.f;
		this.phase += TAU * f * 0.995 / sampleRate;
		if (this.phase > TAU) this.phase -= TAU;
		const n = white();
		const tone = Math.sin(this.phase) * 0.35 + Math.sin(this.phase * 2) * 0.12;
		return this.level * (this.bp.run(n) * 3 + this.bp2.run(n) * 1.5 + tone * 0.4);
	}
}

/**
 * A small feedback-delay network: the open air around the car is not a room,
 * but a dry synthesised engine sounds like it is inside the speaker.
 */
class Space {
	constructor() {
		this.lens = [1117, 1453, 1777, 1993].map((l) => Math.round(l * sampleRate / 48000));
		this.lines = this.lens.map((l) => new Delay(l + 4));
		this.damp = this.lens.map(() => new OnePole(3800));
		this.road = new Delay(512);
	}
	/** Returns [left, right] wet signal; `dry` is mono. */
	tick(dry, out) {
		const g = 0.5;
		const y = this.lines.map((l, k) => this.damp[k].run(l.read(this.lens[k])));
		// Householder mix keeps the network lossless before the damping
		const sum = (y[0] + y[1] + y[2] + y[3]) * 0.5;
		for (let k = 0; k < 4; k++) this.lines[k].push(dry * 0.25 + (y[k] - sum) * g);
		out[0] = y[0] - y[2];
		out[1] = y[1] - y[3];
	}
	/** The road under the car: one bounce about 3.5 ms late. */
	bounce(x) {
		this.road.push(x);
		return this.road.read(Math.round(0.0035 * sampleRate));
	}
}

const DEFAULTS = {
	rpm: 1000, load: 0, throttle: 0, cut: 0, limit: 0, shaft: 0,
	speed: 0, slideL: 0, slideR: 0, loadL: 3500, loadR: 3500,
	rumble: 0.08, gravel: 0, inside: 0, volume: 0.9, muted: 0,
};

class CarAudio extends AudioWorkletProcessor {
	constructor() {
		super();
		this.target = { ...DEFAULTS };
		this.cur = { ...DEFAULTS };
		this.engine = new Engine();
		this.eng = [0, 0, 0];
		this.squealL = new Squeal();
		this.squealR = new Squeal();
		this.windBp = new Biquad().set('bp', 400, 0.6);
		this.windLp = new OnePole(1800);
		this.brown = 0;
		this.roadLp = new Biquad().set('lp', 300, 0.7);
		this.cabinBoom = new Biquad().set('peak', 140, 1.2, 5);
		this.cabinLp = new Biquad().set('lp', 3800, 0.7);
		this.crunch = 0;
		this.crunchHp = new Biquad().set('hp', 900, 0.7);
		this.impact = 0;
		this.impactLp = new Biquad().set('lp', 240, 0.8);
		this.ring = 0;
		this.ringPhase = 0;
		this.master = 0;
		this.space = new Space();
		this.wet = [0, 0];
		this.port.onmessage = (e) => {
			const m = e.data;
			if (m.params) Object.assign(this.target, m.params);
			if (m.event === 'upshift') this.engine.bang = 0.55 + 0.45 * this.target.load;
			if (m.event === 'impact') {
				this.impact = Math.min(1.5, m.strength);
				this.ring = m.metal ? Math.min(1, m.strength) : 0;
			}
		};
	}

	process(_inputs, outputs) {
		const out = outputs[0];
		const L = out[0], R = out[1] ?? out[0];
		const n = L.length;
		const t = this.target, c = this.cur;
		// glide every parameter across the block; switches (cut, limit) snap
		const start = { ...c };
		for (const k in t) if (k !== 'cut' && k !== 'limit' && k !== 'inside') c[k] = c[k] + (t[k] - c[k]) * 0.35;
		c.cut = t.cut;
		c.limit = t.limit;
		c.inside += (t.inside - c.inside) * 0.2;
		const inside = c.inside;
		const speed = c.speed;
		this.windBp.set('bp', 220 + speed * 11, 0.6);
		this.roadLp.set('lp', 160 + speed * 5, 0.7);
		const windGain = Math.min(1.2, (speed / 55) ** 2) * (0.35 + 0.45 * inside);
		const roadGain = Math.min(1, speed / 50) * (0.25 + 1.6 * c.rumble) * (0.55 + 0.6 * inside);
		const crunchRate = c.gravel * Math.min(1, speed / 15) * 900 / sampleRate;
		const exGain = 0.85 - 0.4 * inside;
		const inGain = 0.22 + 0.55 * inside;
		const mechGain = 0.1 + 0.3 * inside;
		const tyreGain = 0.8 - 0.25 * inside;
		const target = c.muted ? 0 : c.volume;
		this.engine.block();
		this.squealL.block(c.slideL, n);
		this.squealR.block(c.slideR, n);
		for (let i = 0; i < n; i++) {
			const f = i / n;
			const rpm = start.rpm + (c.rpm - start.rpm) * f;
			const load = start.load + (c.load - start.load) * f;
			const throttle = start.throttle + (c.throttle - start.throttle) * f;
			this.engine.tick(rpm, load, throttle, c.cut, c.limit, c.shaft, this.eng);
			let ex = this.eng[0], intake = this.eng[1], mech = this.eng[2];
			// a soft saturation, as hot pipes and a small speaker both do
			ex = Math.tanh(ex * 0.9) * 0.95;
			if (inside > 0.01) ex = ex * (1 - inside) + this.cabinLp.run(this.cabinBoom.run(ex)) * inside;
			const engine = ex * exGain + intake * inGain + mech * mechGain;

			const wind = this.windLp.run(this.windBp.run(white())) * windGain;
			this.brown = this.brown * 0.995 + white() * 0.05;
			const road = this.roadLp.run(this.brown) * roadGain;
			if (rnd() < crunchRate) this.crunch = 0.6 + 0.4 * rnd();
			const crunch = this.crunchHp.run(white() * this.crunch) * 0.5;
			this.crunch *= 0.985;
			let hit = 0;
			if (this.impact > 0.001) {
				hit = this.impactLp.run(white()) * this.impact * 3;
				this.impact *= 0.9985;
				if (this.ring > 0.001) {
					this.ringPhase += TAU * 1730 / sampleRate;
					hit += Math.sin(this.ringPhase) * Math.sin(this.ringPhase * 1.47) * this.ring * 0.4;
					this.ring *= 0.9993;
				}
			}
			const sqL = this.squealL.tick(c.slideL, c.loadL) * tyreGain;
			const sqR = this.squealR.tick(c.slideR, c.loadR) * tyreGain;

			this.master += (target - this.master) * 0.0008;
			let mid = engine + road + hit + crunch;
			mid += this.space.bounce(engine) * 0.35 * (1 - inside);
			this.space.tick(mid + (sqL + sqR) * 0.5, this.wet);
			const wet = 0.16 - 0.08 * inside;
			L[i] = Math.tanh((mid + wind * 0.9 + sqL + sqR * 0.35 + this.wet[0] * wet) * this.master);
			R[i] = Math.tanh((mid + wind * 1.1 + sqR + sqL * 0.35 + this.wet[1] * wet) * this.master);
		}
		return true;
	}
}

registerProcessor('car-audio', CarAudio);
