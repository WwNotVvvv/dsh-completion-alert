window.__ModuleLoader__.load({
	id: '@local/dsh-completion-alert',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** Locale namespace owned by this plugin. */
		const NS = 'completionAlert';
		/** localStorage key holding the user's saved preferences. */
		const STORAGE_KEY = 'dsh.completion-alert.v1';
		/** The three distinguishable finish states. */
		const KINDS = ['done', 'error', 'waiting'];
		/** How long after an `api-session/error` the idle edge still counts as that error. */
		const ERROR_WINDOW_MS = 15000;
		/**
		 * Longest reason read aloud, in characters. Provider messages such as
		 * `system cpu overloaded (current: 100.0%, threshold: 99%)` are long and
		 * technical, and a speech engine flattens them into an unintelligible run;
		 * the spoken form is therefore clipped while the notification keeps the
		 * full text, which the user can read at their own pace.
		 */
		const TTS_REASON_MAX = 60;

		/**
		 * Flatten a failure message into something a speech engine reads naturally,
		 * clipped at a word boundary so it never stops mid-token.
		 * @param value - the raw reason, of unknown shape.
		 * @returns the spoken form, or an empty string when there is nothing to say.
		 */
		function spokenReason(value) {
			if (typeof value !== 'string') return '';
			const flat = value.replace(/\s+/g, ' ').trim();
			if (flat.length <= TTS_REASON_MAX) return flat;
			const cut = flat.slice(0, TTS_REASON_MAX);
			const at = cut.lastIndexOf(' ');
			return (at > TTS_REASON_MAX * 0.6 ? cut.slice(0, at) : cut).trim();
		}

		/**
		 * The punctuation that separates two spoken phrases in the language the
		 * first phrase is written in, so the pause lands where a listener expects.
		 * @param text - the leading phrase.
		 * @returns a separator including its trailing space.
		 */
		function spokenJoin(text) {
			return /[\u3400-\u9fff\uf900-\ufaff]/.test(text) ? '，' : ', ';
		}

		/**
		 * The interruption families a user can give their own wording to, in display
		 * order. `unknown` is the catch-all and is always last.
		 *
		 * Deliberately a curated list rather than the full code inventory: a provider
		 * — and any relay station in front of it — fails in a handful of recognisable
		 * ways, and a spoken alert only helps if the phrasing is short and distinct.
		 */
		const REASON_KINDS = ['auth', 'quota', 'rate', 'server', 'network', 'endpoint', 'malformed', 'context', 'request', 'unknown'];

		/**
		 * The adapter's stable, provider-neutral codes per family. These are matched
		 * exactly, and are the strongest signal available.
		 */
		const REASON_CODES = {
			auth: ['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'NO_CREDENTIAL_STORE', 'UNSTORABLE_PROVIDER_ID', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT'],
			quota: ['QUOTA', 'ACCOUNT_QUOTA'],
			rate: ['RATE_LIMIT'],
			server: ['SERVER'],
			network: ['TRANSPORT', 'STREAM_CLOSED', 'TIMEOUT', 'ABORTED'],
			// A wrong base URL, a removed model, or an unconfigured provider. Common
			// with relay stations, where the address or the model name is the mistake.
			endpoint: ['NO_ADAPTER', 'UNKNOWN_MODEL', 'DISCOVERY_FAILED', 'DISCOVERY_UNSUPPORTED', 'INVALID_ADAPTER'],
			malformed: ['MALFORMED_RESPONSE', 'EMPTY_RESPONSE', 'INVALID_RESPONSE', 'INVALID_REPLAY_STATE', 'REQUEST_EXTENSION'],
			context: ['CONTEXT_WINDOW_EXCEEDED'],
			request: ['INVALID_REQUEST', 'IMAGE_OFFLOAD_REQUIRED'],
		};

		/**
		 * Message fallbacks per family, ordered most specific first so a narrow
		 * signal is never swallowed by a broad one.
		 *
		 * A relay station does not always answer with the adapter's codes: it may
		 * return a bare HTTP status, an HTML error page, or its own wording, in
		 * either language. Matching the raw text is what keeps those recognisable,
		 * and these patterns are only consulted when no exact code matched.
		 */
		const REASON_PATTERNS = [
			['auth', /unauthor|invalid\s*(api[-\s]?key|token|credential)|authenticat|permission|forbidden|\b40[13]\b|密钥|鉴权|认证/i],
			['quota', /quota|insufficient|balance|billing|credit|\b402\b|余额|额度|欠费/i],
			['rate', /rate[-\s]?limit|too many requests|\b429\b|限流|频率|请求过快/i],
			['context', /context\s*(length|window)|too\s+(long|large)|maximum.{0,12}tokens|上下文|超出.{0,6}长度/i],
			['malformed', /invalid\s*json|unexpected\s+token|malformed|parse|no\s+content|empty\s+(response|body)|格式|解析/i],
			// Checked before the request/server rules: a 404 or a missing model names a
			// wrong address rather than a bad payload, and the fix is different. 422 is
			// deliberately absent — it is a payload-validation status, not an address one.
			['endpoint', /not\s+found|no\s+such|\b404\b|unknown\s+(model|provider)|no\s+(adapter|configured)\s*(model|provider)?|model.{0,20}(not|no).{0,12}(exist|available)|地址|模型不存在/i],
			['request', /invalid\s+request|bad\s+request|\b4(00|13|22)\b|not\s+support|unsupported|请求无效|不支持/i],
			['server', /\b5\d\d\b|overload|bad\s+gateway|service\s+unavailable|internal\s+server|upstream|服务|网关/i],
			['network', /timeout|timed\s+out|econn|socket|network|fetch\s+failed|stream\s+ended|closed|disconnect|超时|连接|中断/i],
		];

		/**
		 * One representative adapter code per family, used only by the preview button
		 * so the user hears the wording their own entry would produce. `unknown` has
		 * no code, which is exactly how the catch-all is reached in practice.
		 */
		const REASON_SAMPLE_CODES = {
			auth: 'AUTH',
			quota: 'QUOTA',
			rate: 'RATE_LIMIT',
			server: 'SERVER',
			network: 'STREAM_CLOSED',
			endpoint: 'UNKNOWN_MODEL',
			malformed: 'MALFORMED_RESPONSE',
			context: 'CONTEXT_WINDOW_EXCEEDED',
			request: 'INVALID_REQUEST',
			unknown: '',
		};

		/**
		 * Which family one failure belongs to. The code wins when present, because a
		 * message may be provider-specific prose; the text is the fallback.
		 * @param code - the adapter's stable failure code, when the log carried one.
		 * @param detail - the human-readable message, used as the fallback signal.
		 * @returns the family id, never empty.
		 */
		function categorizeFailure(code, detail) {
			if (typeof code === 'string' && code !== '') {
				for (const [family, codes] of Object.entries(REASON_CODES)) {
					if (codes.includes(code)) return family;
				}
			}
			if (typeof detail === 'string' && detail !== '') {
				for (const [family, pattern] of REASON_PATTERNS) {
					if (pattern.test(detail)) return family;
				}
			}
			return 'unknown';
		}

		/**
		 * The readable phrase for one failure family: the user's own wording when they
		 * wrote any, otherwise the built-in phrase in the interface language.
		 *
		 * Shared by the spoken alert and the notification body so the two never
		 * disagree about what the problem was called.
		 * @param settings - the live preferences.
		 * @param family - one of `REASON_KINDS`.
		 * @param t - bound translator.
		 * @returns the phrase, or an empty string when none should be shown.
		 */
		function reasonPhraseOf(settings, family, t) {
			const custom = settings.sound?.reasonText?.[family];
			if (typeof custom === 'string' && custom.trim() !== '') return custom.trim();
			const fallback = t('reason.' + family);
			return typeof fallback === 'string' && fallback !== 'reason.' + family ? fallback : '';
		}

		//#region settings
		/** Factory defaults; every field is user-editable from the settings page. */
		function defaultSettings() {
			return {
				enabled: true,
				events: { done: true, error: true, waiting: true },
				includeSubagents: false,
				sound: {
					mode: 'tone',
					volume: 0.7,
					/**
					 * Legacy single-clip field, kept so an existing choice still plays. New
					 * audio is stored per role in IndexedDB; this is only read as a fallback.
					 */
					audioUrl: '',
					/**
					 * Voice roles, in precedence order. Each role names a voice and may fill
					 * any subset of the three finish states; the first role that filled a
					 * state owns it, and a state nobody filled falls back to the built-in
					 * tone. Only names live here — the audio itself is in IndexedDB, because
					 * base64 in localStorage would inflate it by a third and hit the quota.
					 */
					roles: [],
					/**
					 * Spoken language tag. Empty means "use the interface language": a
					 * stored default would freeze whichever language was current when the
					 * plugin was first installed, so a user who switches the interface
					 * — or a recipient who never used the author's language — would keep
					 * hearing the old one. The active locale is read at speak time.
					 */
					ttsLang: '',
					ttsRate: 1,
					/**
					 * Preferred system voice, by `voiceURI` (falling back to its display
					 * name). Empty means "let the language tag decide", which is the safe
					 * default because the available voices differ per machine.
					 */
					ttsVoice: '',
					/**
					 * Leading silence before speech starts, in milliseconds. Speech
					 * synthesisers ramp up over their first few tens of milliseconds, so
					 * a phrase that begins immediately loses its first syllable. A short
					 * lead-in lets the engine reach full level before the first word.
					 */
					ttsLeadMs: 350,
					/**
					 * One spoken phrase per finish state. Empty means "use the built-in
					 * phrase for the active language", which is why the defaults are
					 * empty: a literal stored default would hard-code the author's
					 * language into every installation instead of following the
					 * interface, and it would also survive a language switch.
					 */
					ttsText: {
						done: '',
						error: '',
						waiting: '',
					},
					/**
					 * Append the concrete interruption reason to the spoken text, so an
					 * error is heard rather than merely announced. The reason is the
					 * message the conversation itself shows, shortened for speech; the
					 * notification always carries it in full.
					 */
					ttsSpeakReason: false,
					/**
					 * Per-family spoken wording, keyed by `REASON_KINDS`. An empty entry
					 * means "use the built-in phrase for this family", which is why the
					 * defaults are empty: the phrase then follows the interface language
					 * instead of being frozen at whatever was stored first.
					 */
					reasonText: {
						auth: '',
						quota: '',
						rate: '',
						server: '',
						network: '',
						endpoint: '',
						malformed: '',
						context: '',
						request: '',
						unknown: '',
					},
				},
				/**
				 * The reminder channels. There is deliberately no in-page card: an element
				 * inside the DSH window is not rendered once that window is minimised, so
				 * it could never serve the one case this feature exists for. The screen
				 * notification covers a visible window, and the taskbar badge covers a
				 * minimised one.
				 */
				notify: {
					native: true,
					/**
					 * Number badge on the DSH taskbar button: how many conversations
					 * finished while the user was not looking at them. Opening such a
					 * conversation retires one count, and zero clears the badge.
					 */
					badge: true,
				},
			};
		}

		/** Deep-merge a stored/partial value onto a fresh default, ignoring unknown shapes. */
		function mergeSettings(base, patch) {
			if (patch === null || typeof patch !== 'object') return base;
			const out = Array.isArray(base) ? base.slice() : { ...base };
			for (const [key, value] of Object.entries(patch)) {
				if (!(key in out)) continue;
				const current = out[key];
				if (Array.isArray(current) && Array.isArray(value)) {
					// User-managed lists (the voice roles) are replaced wholesale. Merging
					// them index-wise would silently drop every entry once the stored list
					// is longer than the incoming one.
					out[key] = value.slice();
				} else if (current !== null && typeof current === 'object' && !Array.isArray(current)
					&& value !== null && typeof value === 'object' && !Array.isArray(value)) {
					out[key] = mergeSettings(current, value);
				} else if (typeof value === typeof current) {
					out[key] = value;
				}
			}
			return out;
		}

		/** Read persisted preferences, falling back to defaults on any failure. */
		function loadSettings() {
			try {
				if (typeof localStorage === 'undefined') return defaultSettings();
				const raw = localStorage.getItem(STORAGE_KEY);
				if (raw === null) return defaultSettings();
				return mergeSettings(defaultSettings(), JSON.parse(raw));
			} catch (error) {
				console.warn('[completion-alert] settings read failed:', error);
				return defaultSettings();
			}
		}

		/** Persist preferences, ignoring quota/availability failures. */
		function persistSettings(value) {
			try {
				if (typeof localStorage === 'undefined') return;
				localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
			} catch (error) {
				console.warn('[completion-alert] settings write failed:', error);
			}
		}

		/**
		 * Minimal observable snapshot source: the exact `getSnapshot`/`subscribe`
		 * pair the slot renderer binds a `hooks` entry to.
		 * @param initial - first published value.
		 * @returns a store with `set`.
		 */
		function createStore(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => value,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set(next) {
					value = next;
					for (const listener of [...listeners]) {
						try {
							listener();
						} catch (error) {
							console.error('[completion-alert] listener failed:', error);
						}
					}
				},
			};
		}
		//#endregion

		//#region clip store (IndexedDB)
		/** Database and object store holding the user's audio clips as Blobs. */
		const DB_NAME = 'dsh-completion-alert';
		const DB_STORE = 'clips';
		/** Largest clip accepted, matching the settings-page copy. */
		const MAX_CLIP_BYTES = 768 * 1024;

		/**
		 * Blob storage for voice clips.
		 *
		 * localStorage is the wrong home for audio: it only holds strings, so a clip
		 * must be base64-encoded (a third larger), and the whole quota is a few MB.
		 * IndexedDB stores the Blob directly and is sized to the disk instead.
		 *
		 * Every method resolves rather than rejects on failure — a browser with
		 * IndexedDB disabled must still leave the rest of the plugin working, just
		 * without custom clips.
		 * @returns the clip store surface, plus object URLs for playback.
		 */
		function createClipStore() {
			let handle;
			/** Object URLs handed out for playback, revoked on replace or dispose. */
			const urls = new Map();
			const open = () => {
				if (handle !== undefined) return handle;
				handle = new Promise((resolve, reject) => {
					if (typeof indexedDB === 'undefined') {
						reject(new Error('IndexedDB unavailable'));
						return;
					}
					const request = indexedDB.open(DB_NAME, 1);
					request.onupgradeneeded = () => {
						const db = request.result;
						if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
					};
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error ?? new Error('open failed'));
					request.onblocked = () => reject(new Error('open blocked'));
				}).catch((error) => {
					// Cache the rejection so every later call fails fast and identically.
					console.warn('[completion-alert] clip store unavailable:', error);
					return undefined;
				});
				return handle;
			};
			const run = async (mode, work) => {
				const db = await open();
				if (db === undefined) return undefined;
				return new Promise((resolve) => {
					let transaction;
					try {
						transaction = db.transaction(DB_STORE, mode);
					} catch (error) {
						console.warn('[completion-alert] clip transaction failed:', error);
						resolve(undefined);
						return;
					}
					const store = transaction.objectStore(DB_STORE);
					let result;
					try {
						result = work(store);
					} catch (error) {
						console.warn('[completion-alert] clip request failed:', error);
						resolve(undefined);
						return;
					}
					transaction.oncomplete = () => resolve(result?.result);
					transaction.onerror = () => {
						console.warn('[completion-alert] clip transaction error:', transaction.error);
						resolve(undefined);
					};
					transaction.onabort = () => resolve(undefined);
				});
			};
			/** Drop the cached object URL for one key, so a replacement is not masked. */
			const revoke = (key) => {
				const url = urls.get(key);
				if (url === undefined) return;
				try {
					URL.revokeObjectURL(url);
				} catch { /* already gone */ }
				urls.delete(key);
			};
			return {
				/** Store or replace one clip. Resolves false when storage is unavailable. */
				async put(key, blob) {
					const ok = await run('readwrite', (store) => store.put(blob, key));
					revoke(key);
					// A successful put resolves with the key; anything falsy means it failed.
					return ok !== undefined || (await this.has(key));
				},
				/** Read one clip, or undefined when absent or unavailable. */
				async get(key) {
					const value = await run('readonly', (store) => store.get(key));
					return value instanceof Blob ? value : undefined;
				},
				/** True when a clip is stored under this key. */
				async has(key) {
					const value = await run('readonly', (store) => store.get(key));
					return value instanceof Blob;
				},
				/** Remove one clip. */
				async remove(key) {
					await run('readwrite', (store) => store.delete(key));
					revoke(key);
				},
				/**
				 * A playable URL for one clip, cached per key so repeated alerts reuse a
				 * single object URL instead of leaking one per playback.
				 */
				async url(key) {
					const cached = urls.get(key);
					if (cached !== undefined) return cached;
					const blob = await this.get(key);
					if (blob === undefined) return undefined;
					try {
						const objectUrl = URL.createObjectURL(blob);
						urls.set(key, objectUrl);
						return objectUrl;
					} catch (error) {
						console.warn('[completion-alert] object URL failed:', error);
						return undefined;
					}
				},
				/** Keys currently stored, for the "which states are filled" readout. */
				async keys() {
					const value = await run('readonly', (store) => store.getAllKeys());
					return Array.isArray(value) ? value : [];
				},
				dispose() {
					for (const key of [...urls.keys()]) revoke(key);
					void open().then((db) => {
						try {
							db?.close();
						} catch { /* already closed */ }
					});
					handle = undefined;
				},
			};
		}
		//#endregion

		//#region audio
		/**
		 * Audio engine: one lazily-created AudioContext for the built-in chimes, the
		 * Web Speech API for spoken text, and an `Audio` element for a user file.
		 * Every path fails soft — a blocked or unsupported channel stays silent.
		 * @param getSettings - reads the live preferences at play time.
		 * @param onBlockedChange - notified whenever the gesture-blocked state settles,
		 * so the UI can explain a silent chime instead of showing nothing.
		 * @param clips - the clip store, read for role audio.
		 * @param t - bound translator, used for the built-in per-family phrases.
		 * @param activeLocale - the interface language tag, read at speak time.
		 * @returns the play/test surface.
		 */
		function createAudio(getSettings, onBlockedChange, clips, t, activeLocale) {
			let context;
			/** The `Audio` element currently playing a clip, if any. */
			let clipElement;
			/**
			 * Set while a context exists but has not yet been allowed to make sound.
			 * An AudioContext created before any user gesture starts suspended, so a
			 * chime at that moment would be silent — exactly the case that matters when
			 * the user is looking at another application.
			 */
			let contextBlocked = false;
			/** Distinct, recognizable note patterns per finish state. */
			const PATTERNS = {
				done: { type: 'sine', notes: [880, 1174.66], noteMs: 170, gapMs: 105 },
				error: { type: 'triangle', notes: [440, 311.13], noteMs: 230, gapMs: 140 },
				waiting: { type: 'sine', notes: [659.25, 659.25, 880], noteMs: 110, gapMs: 75 },
			};
			/** Record the settled blocked state and publish it once. */
			const settleBlocked = (next) => {
				if (contextBlocked === next) return;
				contextBlocked = next;
				onBlockedChange(next);
			};
			const ensureContext = () => {
				if (context !== undefined) return context;
				const Ctor = window.AudioContext ?? window.webkitAudioContext;
				if (Ctor === undefined) return undefined;
				try {
					context = new Ctor();
					// Publish through settleBlocked: assigning the field directly would
					// make the later settle a no-op and the hint would never appear.
					settleBlocked(context.state !== 'running');
				} catch (error) {
					console.warn('[completion-alert] AudioContext unavailable:', error);
					context = undefined;
				}
				return context;
			};
			/** Resume after a gesture, so the next completion is audible. */
			const unlock = () => {
				const audioContext = ensureContext();
				if (audioContext === undefined) return;
				if (audioContext.state === 'running') {
					settleBlocked(false);
					return;
				}
				void audioContext.resume().then(() => {
					settleBlocked(audioContext.state !== 'running');
				}).catch(() => {
					settleBlocked(true);
				});
			};
			const playTone = (kind) => {
				const spec = PATTERNS[kind];
				if (spec === undefined) return;
				const audioContext = ensureContext();
				if (audioContext === undefined) return;
				if (audioContext.state !== 'running') {
					// Attempt anyway: a resume that is already permitted succeeds here.
					settleBlocked(true);
					void audioContext.resume().then(() => {
						settleBlocked(audioContext.state !== 'running');
					}).catch(() => {
						settleBlocked(true);
					});
				} else {
					settleBlocked(false);
				}
				const volume = getSettings().sound.volume;
				let at = audioContext.currentTime + 0.02;
				for (const frequency of spec.notes) {
					const oscillator = audioContext.createOscillator();
					const gain = audioContext.createGain();
					oscillator.type = spec.type;
					oscillator.frequency.setValueAtTime(frequency, at);
					const peak = Math.max(0.0001, Math.min(1, volume) * 0.5);
					gain.gain.setValueAtTime(0.0001, at);
					gain.gain.exponentialRampToValueAtTime(peak, at + 0.015);
					gain.gain.exponentialRampToValueAtTime(0.0001, at + spec.noteMs / 1000);
					oscillator.connect(gain);
					gain.connect(audioContext.destination);
					oscillator.start(at);
					oscillator.stop(at + spec.noteMs / 1000 + 0.02);
					at += (spec.noteMs + spec.gapMs) / 1000;
				}
			};
			/** Pending lead-in timer, so a new request replaces the previous one. */
			let speechTimer;
			/**
			 * The installed system voices, republished whenever the platform finishes
			 * loading them. Chromium populates `getVoices()` asynchronously and fires
			 * `voiceschanged`, so an empty list at first read is normal.
			 */
			const voiceStore = createStore([]);
			const readVoices = () => {
				if (typeof window.speechSynthesis === 'undefined') return [];
				try {
					const list = window.speechSynthesis.getVoices();
					return Array.isArray(list) ? list : [];
				} catch {
					return [];
				}
			};
			const refreshVoices = () => {
				const next = readVoices();
				const previous = voiceStore.getSnapshot();
				// getVoices() returns a fresh array each call; only publish real changes so
				// subscribers do not re-render on every event.
				if (next.length !== previous.length || next.some((v, i) => v.voiceURI !== previous[i]?.voiceURI)) {
					voiceStore.set(next);
				}
			};
			refreshVoices();
			if (typeof window.speechSynthesis !== 'undefined' && typeof window.speechSynthesis.addEventListener === 'function') {
				try {
					window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
				} catch { /* older engines use onvoiceschanged only */ }
			}
			/** Resolve the configured voice, or undefined to let the language decide. */
			const pickVoice = (voices, wanted) => {
				if (typeof wanted !== 'string' || wanted === '') return undefined;
				return voices.find((v) => v.voiceURI === wanted) ?? voices.find((v) => v.name === wanted);
			};
			/**
			 * The phrase to speak for one failure family, resolved against the live
			 * preferences so an edit applies to the next alert without a reload.
			 * @param family - one of `REASON_KINDS`.
			 * @returns the phrase, or an empty string when nothing should be said.
			 */
			const reasonPhrase = (family) => reasonPhraseOf(getSettings(), family, t);
			const speak = (kind, detail, code) => {
				const settings = getSettings();
				const configured = settings.sound.ttsText[kind];
				// An empty field means "use the built-in phrase for the active language",
				// so a fresh install speaks the interface language instead of whatever
				// language the author happened to ship.
				const text = typeof configured === 'string' && configured.trim() !== ''
					? configured
					: t('sound.tts.default.' + kind);
				if (typeof text !== 'string' || text.trim() === '') return;
				// The reason is appended rather than replacing the configured phrase: the
				// phrase names the state, the reason says which failure it was. Only the
				// error state has a reason — the other two are complete statements on
				// their own, and re-reading them would repeat the state.
				const parts = [];
				if (kind === 'error') {
					// The family phrase is the readable half ("the API key is invalid");
					// the raw message is the specific half ("... failed (520)"). Reading
					// both is opt-in, because a provider's prose is often unlistenable.
					const phrase = reasonPhrase(categorizeFailure(code, detail));
					if (phrase !== '') parts.push(phrase);
					if (settings.sound.ttsSpeakReason === true) {
						const raw = spokenReason(detail);
						if (raw !== '' && raw !== phrase) parts.push(raw);
					}
				}
				const spoken = parts.length === 0
					? text
					: text.replace(/\s+$/, '') + spokenJoin(text) + parts.join(spokenJoin(text));
				if (typeof window.speechSynthesis === 'undefined' || typeof window.SpeechSynthesisUtterance === 'undefined') return;
				const synth = window.speechSynthesis;
				const volume = Math.max(0, Math.min(1, settings.sound.volume));
				const leadMs = Math.max(0, Number(settings.sound.ttsLeadMs) || 0);
				// Resolve the voice at speak time: the list may have arrived after the
				// page was configured, and a stale voice object can be dropped by the OS.
				const voice = pickVoice(readVoices(), settings.sound.ttsVoice);
				if (speechTimer !== undefined) {
					window.clearTimeout(speechTimer);
					speechTimer = undefined;
				}
				/**
				 * Speak after the engine has been given time to reach full level.
				 *
				 * `cancel()` does not take effect synchronously in Chromium: speaking in
				 * the same task right after it makes the engine start mid-ramp and swallow
				 * the first syllable — the reported "fades in, first word unclear". So a
				 * cancel is always followed by a fresh task, and the lead-in silence is
				 * waited out before the phrase is queued.
				 */
				const start = () => {
					try {
						const utterance = new window.SpeechSynthesisUtterance(spoken);
						// An empty tag follows the interface language, resolved at speak
						// time so switching the interface also switches the voice.
						utterance.lang = typeof settings.sound.ttsLang === 'string' && settings.sound.ttsLang.trim() !== ''
							? settings.sound.ttsLang.trim()
							: activeLocale();
						utterance.rate = settings.sound.ttsRate;
						utterance.volume = volume;
						// Only assign when resolved: assigning undefined makes some engines
						// ignore the language tag and fall back to the default voice.
						if (voice !== undefined) utterance.voice = voice;
						synth.speak(utterance);
					} catch (error) {
						console.warn('[completion-alert] speech failed:', error);
					}
				};
				const wasSpeaking = synth.speaking === true || synth.pending === true;
				if (wasSpeaking) {
					try {
						synth.cancel();
					} catch { /* a failed cancel must not block speaking */ }
				}
				// Wait out the cancel (when there was one) plus the configured lead-in.
				const wait = leadMs + (wasSpeaking ? 120 : 0);
				// The timer is recorded in both branches: a zero wait still defers to a
				// later task, and an unrecorded one could not be cancelled, so two rapid
				// alerts would both speak and the newer would not replace the older.
				speechTimer = window.setTimeout(() => {
					speechTimer = undefined;
					start();
				}, wait <= 0 ? 0 : wait);
			};
			const playFile = (url) => {
				if (typeof url !== 'string' || url.trim() === '') return false;
				try {
					const element = new Audio(url);
					element.volume = Math.max(0, Math.min(1, getSettings().sound.volume));
					// Keep a handle so a newer alert can cut off a still-playing clip
					// rather than overlapping it.
					if (clipElement !== undefined) {
						try {
							clipElement.pause();
						} catch { /* already stopped */ }
					}
					clipElement = element;
					void element.play().catch((error) => {
						console.warn('[completion-alert] audio playback blocked:', error);
						settleBlocked(true);
					});
					return true;
				} catch (error) {
					console.warn('[completion-alert] audio element failed:', error);
					return false;
				}
			};
			/**
			 * Resolve which clip key a state should use, honouring role precedence.
			 * Roles are ordered, and the first one that filled a state wins, so adding a
			 * role never silently overrides an earlier, more specific choice.
			 * @returns the storage key, or undefined when no role filled this state.
			 */
			const roleKeyFor = (kind) => {
				for (const role of getSettings().sound.roles) {
					if (role?.clips?.[kind] === true) return 'role:' + role.id + ':' + kind;
				}
				return undefined;
			};
			/**
			 * Play the clip for one state, preferring a role clip and falling back to the
			 * built-in tone. The clip lives in IndexedDB, so the read is asynchronous;
			 * the tone is scheduled synchronously when nothing is stored, which keeps the
			 * common no-custom-audio path free of delay.
			 */
			const playClipOrTone = (kind) => {
				const key = roleKeyFor(kind);
				if (key === undefined) {
					playTone(kind);
					return;
				}
				void clips.url(key).then((url) => {
					if (url === undefined || !playFile(url)) playTone(kind);
				}).catch(() => playTone(kind));
			};
			return {
				/** Play the configured channel for one finish state. */
				play(kind, detail, code) {
					if (!getSettings().enabled) return;
					const mode = getSettings().sound.mode;
					if (mode === 'none') return;
					if (mode === 'tts') return speak(kind, detail, code);
					if (mode === 'audio') {
						// A stored role clip is the intended source; the legacy single clip
						// and the built-in tone are progressively weaker fallbacks.
						if (roleKeyFor(kind) !== undefined) return playClipOrTone(kind);
						if (!playFile(getSettings().sound.audioUrl)) playTone(kind);
						return;
					}
					return playTone(kind);
				},
				/** Preview one channel from the settings page, bypassing the master switch. */
				preview(kind, mode, detail, code) {
					unlock();
					if (mode === 'tts') return speak(kind, detail, code);
					if (mode === 'audio') {
						if (roleKeyFor(kind) !== undefined) return playClipOrTone(kind);
						if (!playFile(getSettings().sound.audioUrl)) playTone(kind);
						return;
					}
					return playTone(kind);
				},
				/** Preview one stored clip by its key, regardless of role precedence. */
				previewKey(key) {
					unlock();
					void clips.url(key).then((url) => {
						if (url !== undefined) playFile(url);
					});
				},
				/** True while the browser is withholding sound until a gesture. */
				blocked: () => contextBlocked,
				/** Installed system voices, for the voice picker. */
				voices: voiceStore,
				unlock,
				dispose() {
					if (speechTimer !== undefined) {
						window.clearTimeout(speechTimer);
						speechTimer = undefined;
					}
					if (clipElement !== undefined) {
						try {
							clipElement.pause();
						} catch { /* already stopped */ }
						clipElement = undefined;
					}
					if (typeof window.speechSynthesis !== 'undefined' && typeof window.speechSynthesis.removeEventListener === 'function') {
						try {
							window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices);
						} catch { /* listener was never attached */ }
					}
					try {
						if (typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel();
					} catch { /* nothing to release */ }
					if (context !== undefined) {
						void context.close().catch(() => {});
						context = undefined;
					}
				},
			};
		}
		//#endregion

		//#region native notification
		/**
		 * State markers for the OS notification.
		 *
		 * Windows and macOS render their own notification chrome, so an app cannot
		 * colour it; a leading symbol is the one distinction that survives into the
		 * system surface, and it is what lets the three finish states stay tellable
		 * apart in the corner of the screen.
		 */
		const NATIVE_MARKERS = { done: '\u2705', error: '\u26a0\ufe0f', waiting: '\u2753' };

		/**
		 * OS-level notification, the channel that still reaches the user while another
		 * application owns the screen — and the only one that survives minimising the
		 * DSH window, because an in-page element is never rendered off-window.
		 * Silently unavailable when unsupported, and its permission state is
		 * observable so the settings page can explain a refusal.
		 * @returns the permission store plus the request/show surface.
		 */
		function createNativeChannel() {
			const supported = () => typeof window.Notification !== 'undefined';
			const current = () => {
				if (!supported()) return 'unsupported';
				try {
					return window.Notification.permission ?? 'default';
				} catch {
					return 'unsupported';
				}
			};
			const store = createStore(current());
			const request = () => {
				if (!supported()) return;
				try {
					if (window.Notification.permission !== 'default') {
						store.set(current());
						return;
					}
					const result = window.Notification.requestPermission();
					if (result !== null && typeof result.then === 'function') {
						void result.then((granted) => store.set(granted ?? current())).catch(() => store.set(current()));
					} else {
						store.set(result ?? current());
					}
				} catch (error) {
					console.warn('[completion-alert] notification permission failed:', error);
					store.set(current());
				}
			};
			return {
				request,
				state: store,
				supported,
				/**
				 * Raise one OS notification.
				 * @param kind - finish state, used for the marker and the notification tag.
				 * @param title - already-localized state label.
				 * @param body - the session title or failure detail.
				 * @param silent - true to suppress the system sound, used when this
				 * plugin's own configurable sound already played. When that sound was
				 * blocked, passing false lets the OS beep so the user still hears it.
				 * @returns true when a notification was actually raised.
				 */
				show(kind, title, body, silent = true) {
					if (!supported()) return false;
					try {
						if (window.Notification.permission !== 'granted') return false;
						const marker = NATIVE_MARKERS[kind] ?? '';
						const notification = new window.Notification(marker === '' ? title : marker + ' ' + title, {
							body,
							tag: 'dsh-completion-alert-' + kind,
							silent,
						});
						notification.onclick = () => {
							try {
								window.focus();
								notification.close();
							} catch { /* window control is best-effort */ }
						};
						return true;
					} catch (error) {
						console.warn('[completion-alert] notification failed:', error);
						return false;
					}
				},
			};
		}
		//#endregion

		//#region taskbar badge
		/**
		 * Taskbar badge: the count drawn on the DSH taskbar button.
		 *
		 * This uses the Web Badging API (`navigator.setAppBadge`), which Blink only
		 * forbids inside fenced frames. Electron routes it to its own
		 * `Browser::SetBadgeCount`, and on Windows that renders a dark circle with
		 * the number and applies it with `ITaskbarList3::SetOverlayIcon` — so the
		 * badge appears on the taskbar button itself, which is what makes it visible
		 * when the window is minimised.
		 *
		 * The count answers one question: how many conversations finished while the
		 * user was not looking at them. It therefore drops per *conversation*, not
		 * per notification — and only when that conversation is actually put in
		 * front of the user, which the plugin decides through {@link isViewed}.
		 * @returns the badge surface plus its support probe.
		 */
		function createBadgeChannel() {
			const supported = () => typeof navigator !== 'undefined'
				&& typeof navigator.setAppBadge === 'function';
			/** Session ids that finished and have not been looked at yet. */
			const unread = new Set();
			return {
				supported,
				/** Session ids currently counted. */
				ids: () => [...unread],
				count: () => unread.size,
				/**
				 * Mark one session as owing attention and repaint the badge.
				 * @returns true when the platform badge was actually updated.
				 */
				mark(sessionId) {
					if (sessionId === undefined) return false;
					unread.add(sessionId);
					return this.flush();
				},
				/** Stop counting one session, because the user has now seen it. */
				clear(sessionId) {
					if (!unread.delete(sessionId)) return false;
					return this.flush();
				},
				/** Drop every count, e.g. on reset or when the master switch goes off. */
				clearAll() {
					if (unread.size === 0) return false;
					unread.clear();
					return this.flush();
				},
				/** Repaint the platform badge from the current set. */
				flush() {
					if (!supported()) return false;
					try {
						// Zero is not a valid badge value: the spec requires clearAppBadge
						// instead, and Blink reports a bad message for setAppBadge(0).
						if (unread.size === 0) {
							void navigator.clearAppBadge().catch(() => {});
						} else {
							void navigator.setAppBadge(unread.size).catch(() => {});
						}
						return true;
					} catch (error) {
						console.warn('[completion-alert] badge update failed:', error);
						return false;
					}
				},
			};
		}
		//#endregion

		//#region detection
		/**
		 * The abort cause the conversation renders as a failure rather than a stop.
		 * Signing out mid-turn is not the user choosing to stop, and the conversation
		 * shows it with its own failure row and code, so it must not be announced as
		 * a completed task.
		 */
		const SIGNED_OUT_HOOK = 'deepseek-account/signed-out';

		/**
		 * Classify the reason a session's own `turn/end` recorded.
		 *
		 * This is the authoritative text the conversation itself renders, and it
		 * matters because the forwarded `api-session/error` is not the whole story:
		 * it can arrive with no message, and an aborted turn never emits it at all.
		 * `error` is the ordinary failure ending; a signed-out abort is the one
		 * aborted ending the conversation also treats as a failure. Every other
		 * ending — completed, a user or parent stop, a block, the token cap, a fork
		 * boundary — is not an interruption, so none of them is reported as one.
		 * @param reason - `turn/end`'s `data.reason`, of unknown shape.
		 * @returns the verdict, the reason text, and the stable code when present.
		 */
		function classifyTurnEnd(reason) {
			const none = { failed: false, detail: '', code: '' };
			if (reason === null || typeof reason !== 'object') return none;
			if (reason.kind === 'aborted') {
				const cause = reason.reason;
				if (cause === null || typeof cause !== 'object') return none;
				// The conversation maps this one abort to its own failure row, so it is
				// reported as an interruption and carries that row's code — which is
				// what lets the user's own wording for authentication apply to it.
				return cause.kind === 'hook' && cause.reason === SIGNED_OUT_HOOK
					? { failed: true, detail: '', code: 'ACCOUNT_SIGNED_OUT' }
					: none;
			}
			if (reason.kind !== 'error') return none;
			const failure = reason.error;
			if (failure === null || typeof failure !== 'object') {
				return { failed: true, detail: typeof failure === 'string' ? failure : '', code: '' };
			}
			const message = typeof failure.message === 'string' ? failure.message.trim() : '';
			const code = typeof failure.code === 'string' ? failure.code : '';
			// The code is the fallback only when the message is empty: it is a stable
			// identifier such as SERVER or STREAM_CLOSED, which still tells the user
			// more than a bare "an error occurred" would.
			return { failed: true, detail: message !== '' ? message : code, code };
		}

		/**
		 * Turn the forwarded Host status/error events into finish notifications.
		 * Running edges are per session id, so an unfocused or background session
		 * reports exactly like the one on screen.
		 * @param options - settings reader, emitter, title resolver, subagent filter,
		 * and the session-log reason reader.
		 * @returns the event handlers plus baseline seeding and a reset.
		 */
		function createDetector(options) {
			const running = new Map();
			const errors = new Map();
			const finish = (sessionId) => {
				const settings = options.getSettings();
				if (!settings.enabled || !options.isEligible(sessionId)) return;
				const failure = errors.get(sessionId);
				errors.delete(sessionId);
				const forwardedAt = failure === undefined ? undefined : failure.at;
				const recent = forwardedAt !== undefined && Date.now() - forwardedAt <= ERROR_WINDOW_MS;
				// The session's own log is read for two reasons. It can confirm a
				// failure the forwarded event never announced — a signed-out abort ends
				// the turn in error without dispatching one — and it supplies the
				// wording, because the forwarded message can arrive empty. The read is
				// time-bounded inside `reasonOf` so a turn/end still in flight from an
				// earlier turn cannot be mistaken for this finish.
				const logged = options.reasonOf(sessionId);
				if (!recent && !logged.failed) {
					if (!settings.events.done) return;
					options.emit({ kind: 'done', sessionId, detail: '' });
					return;
				}
				const forwarded = typeof failure?.message === 'string' ? failure.message.trim() : '';
				if (!settings.events.error) return;
				// The message shown and the code used for categorising come from
				// different places when the forwarded message is the richer one: the
				// log still supplies the code, because a relay's prose rarely names it.
				options.emit({
					kind: 'error',
					sessionId,
					detail: forwarded !== '' ? forwarded : logged.detail,
					code: logged.code,
				});
			};
			return {
				onStatus(sessionId, isRunning) {
					const previous = running.get(sessionId);
					running.set(sessionId, isRunning);
					if (previous === true && isRunning === false) finish(sessionId);
				},
				onError(sessionId, message) {
					errors.set(sessionId, { at: Date.now(), message: typeof message === 'string' ? message : '' });
					// A failure with no running interval to close reports immediately.
					if (running.get(sessionId) !== true) finish(sessionId);
				},
				/**
				 * Adopt the list's own running flags as the baseline. The Host only
				 * publishes status *transitions*, so a session already running when this
				 * page loads would otherwise never be seen as running — and its
				 * completion would be silently missed.
				 * @param rows - the current session list rows, keyed by id.
				 */
				seed(rows) {
					for (const [sessionId, row] of Object.entries(rows)) {
						if (running.has(sessionId)) continue;
						if (row?.running === true) running.set(sessionId, true);
					}
				},
				reset() {
					running.clear();
					errors.clear();
				},
			};
		}
		//#endregion

		//#region styles
		/** Plugin-owned stylesheet; only theme tokens carry colour. */
		const CSS = `
.dsh-ca-page{display:flex;flex-direction:column;gap:0;padding:4px 0 24px}
.dsh-ca-head{display:flex;flex-direction:column;gap:4px;padding:6px 0 16px}
.dsh-ca-h1{margin:0;font-size:17px;font-weight:650;color:var(--dsw-alias-label-primary,#f5f5f5)}
.dsh-ca-sub{margin:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.dsh-ca-group{margin:0 0 18px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:11px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,transparent)}
.dsh-ca-group>.dsh-ca-row+.dsh-ca-row{border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}
.dsh-ca-legend{padding:9px 13px;font-size:11.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}
.dsh-ca-row{display:flex;gap:14px;align-items:center;justify-content:space-between;padding:11px 13px}
.dsh-ca-row[data-stacked="true"]{flex-direction:column;align-items:stretch;gap:8px}
.dsh-ca-label{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-ca-label>span:first-child{font-size:13px;color:var(--dsw-alias-label-primary,#f5f5f5)}
.dsh-ca-hint{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.9))}
.dsh-ca-control{flex:none;display:flex;align-items:center;gap:8px}
.dsh-ca-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.2));cursor:pointer;transition:background .16s ease,border-color .16s ease}
.dsh-ca-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-ca-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .16s cubic-bezier(.16,1,.3,1)}
.dsh-ca-switch[aria-checked="true"]::after{transform:translateX(16px)}
.dsh-ca-switch:disabled{opacity:.45;cursor:not-allowed}
.dsh-ca-seg{display:inline-flex;padding:2px;gap:2px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.09))}
.dsh-ca-seg>button{padding:5px 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));font-size:12px;cursor:pointer;white-space:nowrap}
.dsh-ca-seg>button[aria-pressed="true"]{background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#f5f5f5);box-shadow:0 1px 3px rgba(0,0,0,.2)}
.dsh-ca-input,.dsh-ca-select{box-sizing:border-box;width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.34));border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#f5f5f5);font-size:12.5px;font-family:inherit}
.dsh-ca-input:focus,.dsh-ca-select:focus{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-1px}
.dsh-ca-input[type="number"]{width:88px}
.dsh-ca-input[type="range"]{padding:0;border:0;background:transparent}
.dsh-ca-btn{flex:none;padding:6px 11px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.34));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#f5f5f5);font-size:12px;cursor:pointer}
.dsh-ca-btn:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.2))}
.dsh-ca-btn[data-variant="danger"]{color:var(--dsw-alias-state-error-primary,#ef4444);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 45%,transparent)}
.dsh-ca-select{appearance:none;cursor:pointer;padding-right:26px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 15px) calc(50% + 1px),calc(100% - 10px) calc(50% + 1px);background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.dsh-ca-select option{background:var(--dsw-alias-bg-layer-1,#1c1c1e);color:var(--dsw-alias-label-primary,#f5f5f5)}
.dsh-ca-btn[disabled]{opacity:.45;cursor:default}
.dsh-ca-btn[data-kind="done"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 45%,transparent)}
.dsh-ca-btn[data-kind="error"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 45%,transparent)}
.dsh-ca-btn[data-kind="waiting"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent)}
.dsh-ca-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
/* One editable row per interruption family: name, wording, and a preview. */
.dsh-ca-reasons{display:flex;flex-direction:column;gap:6px}
.dsh-ca-reason{display:grid;grid-template-columns:minmax(0,132px) minmax(0,1fr) auto;gap:8px;align-items:center}
.dsh-ca-reasonlabel{font-size:12px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.dsh-ca-card{display:flex;flex-direction:column;gap:7px;padding:10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06))}
.dsh-ca-card>label{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.dsh-ca-card[data-kind="done"]{border-top:2px solid var(--dsw-alias-state-success-primary,#22c55e)}
.dsh-ca-card[data-kind="error"]{border-top:2px solid var(--dsw-alias-state-error-primary,#ef4444)}
.dsh-ca-card[data-kind="waiting"]{border-top:2px solid var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsh-ca-note{padding:0 2px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.9))}
.dsh-ca-preview{display:flex;gap:8px;flex-wrap:wrap;padding-top:2px}
.dsh-ca-role{margin:0 0 10px;padding:10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.05))}
.dsh-ca-role:last-child{margin-bottom:0}
.dsh-ca-rolehead{display:flex;gap:7px;align-items:center;margin-bottom:9px}
.dsh-ca-rolehead>.dsh-ca-input{flex:1;min-width:0}
.dsh-ca-rolehead>.dsh-ca-btn{padding:6px 9px;min-width:32px}
.dsh-ca-pick{display:flex;align-items:center;gap:7px;cursor:pointer}
.dsh-ca-file{max-width:100%;font-size:11px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.dsh-ca-file::file-selector-button{padding:4px 8px;margin-right:7px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.34));border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#f5f5f5);font-size:11.5px;font-family:inherit;cursor:pointer}
.dsh-ca-empty{padding:16px;font-size:12.5px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
`;
		//#endregion

		//#region components
		/**
		 * Headless frame-wide watcher.
		 *
		 * It exists for the one fact the plugin cannot read from its own event
		 * stream: a pending interaction arriving on the client's own projection. It
		 * draws nothing — the visible reminders are the screen notification and the
		 * taskbar badge, and an element inside this window could never be seen while
		 * the window is minimised.
		 */
		function AlertHost({ useSessionStatus, notifyWaiting }) {
			const statuses = useSessionStatus === undefined ? undefined : useSessionStatus((snapshot) => snapshot);
			const previous = React.useRef(null);
			React.useEffect(() => {
				if (useSessionStatus === undefined || statuses === undefined) return;
				const before = previous.current;
				previous.current = statuses;
				// The first snapshot only seeds the baseline; it is not an arrival.
				if (before === null) return;
				for (const [sessionId, status] of statuses) {
					const interaction = status?.pendingInteraction;
					if (interaction === undefined || interaction === null) continue;
					// Compare identity, not presence: one session can answer a question
					// and raise a new one between two snapshots, and that second arrival
					// must alert too.
					const earlier = before.get(sessionId)?.pendingInteraction;
					if (earlier === interaction) continue;
					notifyWaiting(sessionId, interaction.kind);
				}
			}, [statuses, notifyWaiting, useSessionStatus]);
			return null;
		}

		/** Accessible switch built to the host's `role="switch"` convention. */
		function Switch({ checked, onChange, disabled, label }) {
			return h('button', {
				type: 'button',
				role: 'switch',
				className: 'dsh-ca-switch',
				'aria-checked': checked ? 'true' : 'false',
				'aria-label': label,
				disabled: disabled === true,
				onClick: () => onChange(!checked),
			});
		}

		/** One labelled settings row. */
		function Row({ title, hint, children, stacked }) {
			return h('div', { className: 'dsh-ca-row', 'data-stacked': stacked ? 'true' : undefined },
				h('div', { className: 'dsh-ca-label' },
					h('span', null, title),
					hint !== undefined && hint !== '' ? h('span', { className: 'dsh-ca-hint' }, hint) : null,
				),
				h('div', { className: 'dsh-ca-control' }, children),
			);
		}

		/** Segmented single-choice control. */
		function Segmented({ value, options, onChange }) {
			return h('div', { className: 'dsh-ca-seg', role: 'group' },
				options.map((option) => h('button', {
					key: option.value,
					type: 'button',
					'aria-pressed': value === option.value ? 'true' : 'false',
					onClick: () => onChange(option.value),
				}, option.label)),
			);
		}

		/** The full customization page under Settings. */
		function SettingsPage({ useSettings, useNativeState, useSoundBlocked, useVoices, updateSettings, previewAlert, previewSound, previewClip, setRoleClip, clearRoleClip, addRole, removeRole, renameRole, moveRole, resetSettings, requestNativePermission, badgeSupported, localeTag, t }) {
			const settings = useSettings((snapshot) => snapshot);
			const nativeState = useNativeState((snapshot) => snapshot);
			const soundBlocked = useSoundBlocked((snapshot) => snapshot);
			const voices = useVoices((snapshot) => snapshot);
			/** Draft text for the "add a role" field; transient, so not persisted. */
			const [newRoleName, setNewRoleName] = React.useState('');
			const sound = settings.sound;
			const notify = settings.notify;
			const setSound = (patch) => updateSettings({ sound: patch });
			const setNotify = (patch) => updateSettings({ notify: patch });
			const setEvent = (kind, value) => updateSettings({ events: { [kind]: value } });

			/**
			 * Read one picked file and hand the Blob to storage. The size cap is checked
			 * here rather than in storage so the user gets an immediate, specific message
			 * instead of a silent no-op.
			 */
			const onPickRoleClip = (event, roleId, kind) => {
				const input = event.target;
				const file = input.files?.[0];
				if (file === undefined) return;
				if (file.size > MAX_CLIP_BYTES) {
					window.alert(t('role.tooLarge'));
					input.value = '';
					return;
				}
				void setRoleClip(roleId, kind, file).catch(() => window.alert(t('role.failed')));
				// Allow re-picking the same file, which otherwise fires no change event.
				input.value = '';
			};

			return h('div', { className: 'dsh-ca-page' },
				h('div', { className: 'dsh-ca-head' },
					h('h1', { className: 'dsh-ca-h1' }, t('page.title')),
					h('p', { className: 'dsh-ca-sub' }, t('page.subtitle')),
				),

				h('div', { className: 'dsh-ca-group' },
					h('div', { className: 'dsh-ca-legend' }, t('group.master')),
					h(Row, { title: t('master.enabled'), hint: t('master.enabled.hint') },
						h(Switch, {
							checked: settings.enabled,
							label: t('master.enabled'),
							onChange: (value) => updateSettings({ enabled: value }),
						}),
					),
					h(Row, { title: t('master.subagents'), hint: t('master.subagents.hint') },
						h(Switch, {
							checked: settings.includeSubagents,
							label: t('master.subagents'),
							onChange: (value) => updateSettings({ includeSubagents: value }),
						}),
					),
					h(Row, { title: t('master.reset'), hint: t('master.reset.hint') },
						h('button', {
							type: 'button',
							className: 'dsh-ca-btn',
							'data-variant': 'danger',
							onClick: resetSettings,
						}, t('master.reset')),
					),
				),

				h('div', { className: 'dsh-ca-group' },
					h('div', { className: 'dsh-ca-legend' }, t('group.events')),
					KINDS.map((kind) => h(Row, {
						key: kind,
						title: t('kind.' + kind + '.title'),
						hint: t('kind.' + kind + '.hint'),
					},
						h(Switch, {
							checked: settings.events[kind],
							disabled: !settings.enabled,
							label: t('kind.' + kind + '.title'),
							onChange: (value) => setEvent(kind, value),
						}),
					)),
				),

				h('div', { className: 'dsh-ca-group' },
					h('div', { className: 'dsh-ca-legend' }, t('group.preview')),
					// One preview surface only. A real finish plays the sound and raises the
					// notice together, so previewing them separately was both redundant and
					// misleading about what the user will actually get.
					h(Row, { title: t('preview.alert'), hint: t('preview.alert.hint') },
						KINDS.map((kind) => h('button', {
							key: kind,
							type: 'button',
							className: 'dsh-ca-btn',
							'data-kind': kind,
							onClick: () => previewAlert(kind),
						}, t('kind.' + kind + '.title'))),
					),
				),

				h('div', { className: 'dsh-ca-group' },
					h('div', { className: 'dsh-ca-legend' }, t('group.sound')),
					h(Row, { title: t('sound.mode'), hint: t('sound.mode.hint.' + sound.mode) },
						h(Segmented, {
							value: sound.mode,
							options: [
								{ value: 'tone', label: t('sound.mode.tone') },
								{ value: 'tts', label: t('sound.mode.tts') },
								{ value: 'audio', label: t('sound.mode.audio') },
								{ value: 'none', label: t('sound.mode.none') },
							],
							onChange: (value) => setSound({ mode: value }),
						}),
					),
					// Volume and every audition button belong to an audible mode. Hiding them
					// under 静音 keeps the page honest: nothing here can have an effect.
					sound.mode === 'none' ? h(Row, { title: t('sound.silent'), hint: t('sound.silent.hint') }) : null,
					sound.mode === 'none' ? null : h(Row, { title: t('sound.volume'), hint: String(Math.round(sound.volume * 100)) + '%' },
						h('input', {
							type: 'range',
							className: 'dsh-ca-input',
							min: 0,
							max: 1,
							step: 0.05,
							value: sound.volume,
							'aria-label': t('sound.volume'),
							onChange: (event) => setSound({ volume: Number(event.target.value) }),
						}),
					),
					sound.mode === 'tts' ? h(Row, { stacked: true, title: t('sound.tts.text'), hint: t('sound.tts.text.hint') },
						h('div', { className: 'dsh-ca-grid' },
							KINDS.map((kind) => h('div', { key: kind, className: 'dsh-ca-card', 'data-kind': kind },
								h('label', null, t('kind.' + kind + '.title')),
								h('input', {
									type: 'text',
									className: 'dsh-ca-input',
									value: sound.ttsText[kind],
									// The built-in phrase is the placeholder, so an empty
									// field shows exactly what will be spoken.
									placeholder: t('sound.tts.default.' + kind),
									'aria-label': t('kind.' + kind + '.title'),
									onChange: (event) => setSound({ ttsText: { [kind]: event.target.value } }),
								}),
							)),
						),
					) : null,
					// Per-family wording is what makes an error actionable by ear while
					// the user is in another application. Each family is editable, and
					// an empty field follows the interface language instead of freezing
					// whatever happened to be stored first.
					sound.mode === 'tts' ? h(Row, { stacked: true, title: t('sound.tts.reason'), hint: t('sound.tts.reason.hint') },
						h('div', { className: 'dsh-ca-reasons' },
							REASON_KINDS.map((family) => h('div', { key: family, className: 'dsh-ca-reason' },
								h('label', { className: 'dsh-ca-reasonlabel' }, t('reason.' + family + '.name')),
								h('input', {
									type: 'text',
									className: 'dsh-ca-input',
									value: sound.reasonText?.[family] ?? '',
									placeholder: t('reason.' + family),
									'aria-label': t('reason.' + family + '.name'),
									onChange: (event) => setSound({ reasonText: { [family]: event.target.value } }),
								}),
								h('button', {
									type: 'button',
									className: 'dsh-ca-btn',
									title: t('reason.play'),
									onClick: () => previewAlert('error', REASON_SAMPLE_CODES[family]),
								}, t('reason.play')),
							)),
						),
					) : null,
					// The raw provider message is the specific half of the reason. It is
					// opt-in, because a relay's prose is often unlistenable aloud.
					sound.mode === 'tts' ? h(Row, { title: t('sound.tts.raw'), hint: t('sound.tts.raw.hint') },
						h(Switch, {
							checked: sound.ttsSpeakReason,
							label: t('sound.tts.raw'),
							onChange: (value) => setSound({ ttsSpeakReason: value }),
						}),
					) : null,
					sound.mode === 'tts' ? h(Row, { title: t('sound.tts.voice'), hint: voices.length === 0 ? t('sound.tts.voice.empty') : t('sound.tts.voice.hint') },
						h('select', {
							className: 'dsh-ca-input dsh-ca-select',
							value: sound.ttsVoice,
							'aria-label': t('sound.tts.voice'),
							onChange: (event) => setSound({ ttsVoice: event.target.value }),
						},
							// The empty value means "follow the language tag", which stays the
							// right default when the machine offers no usable voice list.
							h('option', { value: '' }, t('sound.tts.voice.auto')),
							voices.map((voice) => h('option', {
								key: voice.voiceURI ?? voice.name,
								value: voice.voiceURI ?? voice.name,
							}, voice.name + (voice.lang === '' ? '' : ' · ' + voice.lang))),
						),
					) : null,
					sound.mode === 'tts' ? h(Row, { title: t('sound.tts.lang'), hint: t('sound.tts.lang.hint') },
						h('input', {
							type: 'text',
							className: 'dsh-ca-input',
							value: sound.ttsLang,
							// Empty follows the interface language; the hint says so.
							placeholder: localeTag,
							'aria-label': t('sound.tts.lang'),
							onChange: (event) => setSound({ ttsLang: event.target.value }),
						}),
						h('input', {
							type: 'number',
							className: 'dsh-ca-input',
							min: 0.5,
							max: 2,
							step: 0.1,
							value: sound.ttsRate,
							'aria-label': t('sound.tts.rate'),
							onChange: (event) => setSound({ ttsRate: Number(event.target.value) || 1 }),
						}),
					) : null,
					sound.mode === 'tts' ? h(Row, { title: t('sound.tts.lead'), hint: t('sound.tts.lead.hint') },
						h('input', {
							type: 'number',
							className: 'dsh-ca-input',
							min: 0,
							max: 3000,
							step: 50,
							value: sound.ttsLeadMs,
							'aria-label': t('sound.tts.lead'),
							onChange: (event) => setSound({ ttsLeadMs: Math.max(0, Math.min(3000, Number(event.target.value) || 0)) }),
						}),
					) : null,
					sound.mode === 'audio' ? h(Row, { stacked: true, title: t('role.title'), hint: t('role.hint') },
						sound.roles.length === 0
							? h('p', { className: 'dsh-ca-note' }, t('role.empty'))
							: sound.roles.map((role, index) => h('div', {
								key: role.id,
								className: 'dsh-ca-role',
							},
								h('div', { className: 'dsh-ca-rolehead' },
									h('input', {
										type: 'text',
										className: 'dsh-ca-input',
										value: role.name,
										'aria-label': t('role.name'),
										placeholder: t('role.name'),
										onChange: (event) => renameRole(role.id, event.target.value),
									}),
									// Order is the precedence rule, so reordering must be explicit.
									h('button', {
										type: 'button',
										className: 'dsh-ca-btn',
										disabled: index === 0,
										title: t('role.up'),
										onClick: () => moveRole(role.id, -1),
									}, '\u2191'),
									h('button', {
										type: 'button',
										className: 'dsh-ca-btn',
										disabled: index === sound.roles.length - 1,
										title: t('role.down'),
										onClick: () => moveRole(role.id, 1),
									}, '\u2193'),
									h('button', {
										type: 'button',
										className: 'dsh-ca-btn',
										'data-variant': 'danger',
										onClick: () => void removeRole(role.id),
									}, t('role.remove')),
								),
								h('div', { className: 'dsh-ca-grid' },
									KINDS.map((kind) => {
										const filled = role.clips?.[kind] === true;
										return h('div', { key: kind, className: 'dsh-ca-card', 'data-kind': kind },
											h('label', null, t('kind.' + kind + '.title')),
											h('label', { className: 'dsh-ca-pick' },
												h('span', { className: 'dsh-ca-note' }, filled ? t('role.clip.set') : t('role.clip.unset')),
												h('input', {
													type: 'file',
													accept: 'audio/*',
													className: 'dsh-ca-file',
													'aria-label': t('kind.' + kind + '.title'),
													onChange: (event) => onPickRoleClip(event, role.id, kind),
												}),
											),
											h('div', { className: 'dsh-ca-preview' },
												h('button', {
													type: 'button',
													className: 'dsh-ca-btn',
													disabled: !filled,
													onClick: () => previewClip('role:' + role.id + ':' + kind),
												}, t('role.play')),
												h('button', {
													type: 'button',
													className: 'dsh-ca-btn',
													'data-variant': 'danger',
													disabled: !filled,
													onClick: () => void clearRoleClip(role.id, kind),
												}, t('role.clear')),
											),
										);
									}),
								),
							)),
					) : null,
					sound.mode === 'audio' ? h(Row, { title: t('role.add'), hint: t('role.add.hint') },
						h('input', {
							type: 'text',
							className: 'dsh-ca-input',
							value: newRoleName,
							placeholder: t('role.name.placeholder'),
							'aria-label': t('role.add'),
							onChange: (event) => setNewRoleName(event.target.value),
						}),
						h('button', {
							type: 'button',
							className: 'dsh-ca-btn',
							disabled: newRoleName.trim() === '',
							onClick: () => {
								addRole(newRoleName);
								setNewRoleName('');
							},
						}, t('role.add.action')),
					) : null,
					soundBlocked && sound.mode !== 'none' ? h('p', { className: 'dsh-ca-note' }, t('sound.blocked')) : null,
				),

				h('div', { className: 'dsh-ca-group' },
					h('div', { className: 'dsh-ca-legend' }, t('group.notify')),
					h(Row, {
						title: t('notify.native'),
						hint: nativeState === 'granted' ? t('notify.native.hint')
							: nativeState === 'denied' ? t('notify.native.denied')
								: nativeState === 'unsupported' ? t('notify.native.unsupported')
									: t('notify.native.ask'),
					},
						nativeState === 'default' || nativeState === 'denied' ? h('button', {
							type: 'button',
							className: 'dsh-ca-btn',
							onClick: requestNativePermission,
						}, t('notify.native.grant')) : null,
						h(Switch, {
							checked: notify.native,
							disabled: !settings.enabled,
							label: t('notify.native'),
							onChange: (value) => {
								setNotify({ native: value });
								if (value) requestNativePermission();
							},
						}),
					),
					h(Row, {
						title: t('notify.badge'),
						hint: badgeSupported ? t('notify.badge.hint') : t('notify.badge.unsupported'),
					},
						h(Switch, {
							checked: notify.badge,
							disabled: !settings.enabled || !badgeSupported,
							label: t('notify.badge'),
							onChange: (value) => setNotify({ badge: value }),
						}),
					),
				),

				h('p', { className: 'dsh-ca-note' }, t('page.footer')),
			);
		}

		/** Compact one-click master switch for the General settings page. */
		function GeneralRow({ useSettings, updateSettings, t }) {
			const settings = useSettings((snapshot) => snapshot);
			return h(Row, { title: t('page.title'), hint: t('general.hint') },
				h(Switch, {
					checked: settings.enabled,
					label: t('page.title'),
					onChange: (value) => updateSettings({ enabled: value }),
				}),
			);
		}
		//#endregion

		//#region plugin
		/**
		 * Services this plugin reads. `uiSession` supplies the root `sessionStatus`
		 * hook (running / pending interaction / completion unread), `sessions` the
		 * list snapshot, and `remote` the Host status and error events.
		 */
		const inject = ['slots', 'remote', 'sessions', 'locale'];

		/**
		 * Client plugin body: wire detection, sound, the two screen-level reminder
		 * channels, and both settings surfaces.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			/** Bound translator for this plugin's namespace. */
			const t = ctx.locale.bind(NS);
			/**
			 * The interface language tag, used when the spoken language is left
			 * automatic. Read on every call so an interface switch applies at once, and
			 * guarded because the locale service settles asynchronously.
			 * @returns a BCP 47 tag, never empty.
			 */
			const activeLocale = () => {
				try {
					const active = ctx.locale.getLocale().active;
					if (typeof active === 'string' && active !== '') return active;
				} catch { /* fall through to the browser's own preference */ }
				return typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language !== ''
					? navigator.language
					: 'en';
			};
			const settingsStore = createStore(loadSettings());
			/** Published separately from settings because it is runtime state, not a preference. */
			const soundBlockedStore = createStore(false);
			const clips = createClipStore();
			const audio = createAudio(
				() => settingsStore.getSnapshot(),
				(blocked) => soundBlockedStore.set(blocked),
				clips,
				t,
				activeLocale,
			);
			const native = createNativeChannel();
			const badge = createBadgeChannel();

			const updateSettings = (patch) => {
				const next = mergeSettings(settingsStore.getSnapshot(), patch);
				settingsStore.set(next);
				persistSettings(next);
				// A disabled feature must not leave a stale count on the taskbar, which
				// would look like a notification the user can never clear.
				if (!next.enabled || !next.notify.badge) badge.clearAll();
				return next;
			};

			/** Store one clip and mark the state as filled on that role. */
			const setRoleClip = async (roleId, kind, blob) => {
				await clips.put('role:' + roleId + ':' + kind, blob);
				const roles = settingsStore.getSnapshot().sound.roles.map((role) => (
					role.id === roleId
						? { ...role, clips: { ...role.clips, [kind]: true } }
						: role
				));
				// Choosing a clip is an explicit statement of intent, so switch the channel
				// over; otherwise the user would upload audio and still hear the tone.
				updateSettings({ sound: { roles, mode: 'audio' } });
			};

			/** Forget one clip and clear the flag that claims it exists. */
			const clearRoleClip = async (roleId, kind) => {
				await clips.remove('role:' + roleId + ':' + kind);
				const roles = settingsStore.getSnapshot().sound.roles.map((role) => (
					role.id === roleId
						? { ...role, clips: { ...role.clips, [kind]: false } }
						: role
				));
				updateSettings({ sound: { roles } });
			};

			/** Append a role, or return the existing one when the name is already used. */
			const addRole = (name) => {
				const trimmed = typeof name === 'string' ? name.trim() : '';
				if (trimmed === '') return undefined;
				const roles = settingsStore.getSnapshot().sound.roles;
				const existing = roles.find((role) => role.name === trimmed);
				if (existing !== undefined) return existing.id;
				// Time-based id: unique per role without needing a counter to persist.
				const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
				updateSettings({
					sound: { roles: [...roles, { id, name: trimmed, clips: { done: false, error: false, waiting: false } }] },
				});
				return id;
			};

			/** Remove a role and every clip it owned. */
			const removeRole = async (roleId) => {
				await Promise.all(KINDS.map((kind) => clips.remove('role:' + roleId + ':' + kind)));
				const roles = settingsStore.getSnapshot().sound.roles.filter((role) => role.id !== roleId);
				updateSettings({ sound: { roles } });
			};

			/** Rename a role in place. */
			const renameRole = (roleId, name) => {
				const trimmed = typeof name === 'string' ? name : '';
				const roles = settingsStore.getSnapshot().sound.roles.map((role) => (
					role.id === roleId ? { ...role, name: trimmed } : role
				));
				updateSettings({ sound: { roles } });
			};

			/** Move a role up or down, which is what decides precedence. */
			const moveRole = (roleId, delta) => {
				const roles = settingsStore.getSnapshot().sound.roles.slice();
				const from = roles.findIndex((role) => role.id === roleId);
				const to = from + delta;
				if (from === -1 || to < 0 || to >= roles.length) return;
				const [moved] = roles.splice(from, 1);
				roles.splice(to, 0, moved);
				updateSettings({ sound: { roles } });
			};

			ctx.effect(() => () => {
				audio.dispose();
				clips.dispose();
			}, 'completion-alert: audio');

			// The browser withholds sound until a user gesture. Create and resume the
			// context on the first interaction so the next completion — including one
			// that arrives while the user is in another application — is audible.
			ctx.effect(() => {
				const events = ['pointerdown', 'keydown', 'touchstart'];
				const onGesture = () => {
					audio.unlock();
					if (!audio.blocked()) for (const event of events) window.removeEventListener(event, onGesture, true);
				};
				for (const event of events) window.addEventListener(event, onGesture, true);
				return () => {
					for (const event of events) window.removeEventListener(event, onGesture, true);
				};
			}, 'completion-alert: audio unlock');

			/** Resolve a session's display title, tolerating an absent list entry. */
			const titleOf = (sessionId) => {
				try {
					const row = ctx.sessions.list.getSnapshot().byId[sessionId];
					return typeof row?.displayTitle === 'string' ? row.displayTitle : sessionId;
				} catch {
					return sessionId;
				}
			};

			/**
			 * Notify only for top-level sessions unless subagent alerts are enabled.
			 * A session absent from the list is not yet known — treat it as top-level
			 * rather than dropping the alert, since the list loads asynchronously and
			 * a missed completion is worse than a redundant one.
			 */
			const isEligible = (sessionId) => {
				const settings = settingsStore.getSnapshot();
				if (settings.includeSubagents) return true;
				try {
					const row = ctx.sessions.list.getSnapshot().byId[sessionId];
					if (row === undefined) return true;
					return row.parentId === undefined;
				} catch {
					return true;
				}
			};

			/**
			 * Whether the conversation is the one currently open in the main view.
			 * Combined with window focus it decides whether a finish is "attended" —
			 * already in front of the user — and therefore needs no notification.
			 */
			const isViewed = (sessionId) => {
				try {
					const row = ctx.sessions.list.getSnapshot().byId[sessionId];
					return row !== undefined && (row.retainedBy?.mainView ?? 0) > 0;
				} catch {
					return false;
				}
			};

			/**
			 * Whether the DSH window itself is the one the user is working in.
			 *
			 * This is what separates "the conversation is open" from "the user is
			 * actually looking at it": leaving a conversation on screen and walking away
			 * to another application must still raise the alert, because that is
			 * precisely the case this feature exists for.
			 *
			 * Every failure path answers "not focused", which errs towards alerting: a
			 * redundant notice is a far smaller cost than a completion the user never
			 * hears about.
			 */
			const windowFocused = () => {
				try {
					return typeof document?.hasFocus === 'function' && document.hasFocus() === true;
				} catch {
					return false;
				}
			};

			/**
			 * Retire the unread mark of the conversation the user is looking at.
			 *
			 * The renderer's own answer to "which conversation is on screen" is
			 * `retainedBy.mainView` on the session list row: the workspace controller
			 * takes exactly one such retention, and the sidebar's completion dot is
			 * driven by the same fact. Reading it from the list — rather than counting
			 * clicks this plugin happens to see — means the mark is also retired when
			 * the user arrives by a route the plugin never observes, such as a restored
			 * window or a fork.
			 *
			 * Focus is required as well, and that is what keeps the count honest in the
			 * case this feature exists for: a conversation left open on screen while the
			 * user works in another application still owes them a look, so its count
			 * must survive until they actually come back.
			 */
			const syncViewed = () => {
				if (!windowFocused()) return;
				let rows;
				try {
					rows = Object.values(ctx.sessions.list.getSnapshot().byId ?? {});
				} catch {
					return;
				}
				for (const row of rows) {
					if ((row?.retainedBy?.mainView ?? 0) > 0) badge.clear(row.id);
				}
			};

			ctx.effect(() => {
				syncViewed();
				const offList = typeof ctx.sessions.list.subscribe === 'function'
					? ctx.sessions.list.subscribe(syncViewed)
					: () => {};
				// Returning to the window is itself the moment the user sees the
				// conversation, and it changes no session row, so it needs its own
				// trigger or the count would linger until something else published.
				window.addEventListener('focus', syncViewed);
				return () => {
					offList();
					window.removeEventListener('focus', syncViewed);
				};
			}, 'completion-alert: viewed conversation tracking');

			/**
			 * One finish notification: the sound, the screen-level notification, and the
			 * taskbar count. Nothing is drawn inside the DSH window, because such a card
			 * would disappear exactly when the window is minimised — the case the whole
			 * feature exists for.
			 */
			const notify = ({ kind, sessionId, detail, code }) => {
				const settings = settingsStore.getSnapshot();
				if (!settings.enabled) return;
				// Watching the conversation finish is not something to be notified
				// about: the chime still plays, but a screen notification over the
				// focused window and an unread count for a conversation already on
				// screen would both be noise. Anything less than "open *and* focused"
				// still alerts.
				const attended = isViewed(sessionId) && windowFocused();
				audio.play(kind, detail, code);
				const title = titleOf(sessionId);
				const label = t('kind.' + kind + '.title');
				// The body leads with the readable family phrase and then the raw message,
				// so a glance at the popup answers "what kind of problem" before the
				// provider's own wording, which may be opaque. The conversation name is
				// kept last: the popup is seen while the user is in another application,
				// so it must still say *which* task this was, and the state label alone
				// does not. A failure with no message still shows the family, which is
				// the whole point of the classification.
				let body = title;
				if (kind === 'error') {
					const phrase = reasonPhraseOf(settings, categorizeFailure(code, detail), t);
					body = [phrase, detail, title].filter((part) => part !== '').join(' · ') || title;
				} else if (detail !== '') {
					body = detail;
				}
				if (settings.notify.native && !attended) {
					// When the browser withheld our own sound, let the OS beep instead:
					// the user is away from the page, so silence would hide the finish.
					native.show(kind, label, body, !audio.blocked());
				}
				// The badge counts sessions that still owe the user a look, so it is
				// keyed by session rather than by notice: several finishes in one
				// conversation stay a single unread mark.
				if (settings.notify.badge && !attended) badge.mark(sessionId);
			};

			/**
			 * Show one finish state without waiting for a real finish, so the screen
			 * surface can be inspected on demand. Deliberately ignores the master switch
			 * and the per-state toggles: previewing a state is how a user decides whether
			 * to keep it on. The badge is left alone — a preview is not an unread
			 * conversation, and inflating the count with one would be a lie.
			 * @param kind - the finish state to render.
			 * @param code - optional failure code to demonstrate one family's wording.
			 */
			const previewAlert = (kind, code) => {
				const sampleTitle = t('preview.task');
				const sampleDetail = kind === 'error' ? t('preview.error')
					: kind === 'waiting' ? t('waiting.question')
						: '';
				// The sample reason is spoken too, so the preview shows the real shape
				// of an error alert — state phrase plus family phrase — rather than a
				// shortened one that would leave the wording settings untested.
				previewSound(kind, sampleDetail, code);
				if (settingsStore.getSnapshot().notify.native) {
					// The popup body is built the same way a real alert builds it, so the
					// preview proves the whole shape — family phrase plus raw message —
					// instead of a sample that only resembles it.
					const phrase = kind === 'error'
						? reasonPhraseOf(settingsStore.getSnapshot(), categorizeFailure(code, sampleDetail), t)
						: '';
					const body = kind === 'error'
						? [phrase, sampleDetail].filter((part) => part !== '').join(' · ') || sampleTitle
						: sampleDetail !== '' ? sampleDetail : sampleTitle;
					native.show(kind, t('kind.' + kind + '.title'), body, false);
				}
			};

			/** Waiting-for-input alerts come from the client's own interaction projection. */
			const notifyWaiting = (sessionId, interactionKind) => {
				const settings = settingsStore.getSnapshot();
				if (!settings.enabled || !settings.events.waiting) return;
				if (!isEligible(sessionId)) return;
				notify({
					kind: 'waiting',
					sessionId,
					detail: t('waiting.' + (interactionKind === 'approval' ? 'approval' : interactionKind === 'plan-review' ? 'plan' : 'question')),
				});
			};

			/**
			 * Read the ending the session's own latest turn recorded.
			 *
			 * The conversation reads the same field from the same place, so this is
			 * exactly what the user would otherwise have to open the conversation to
			 * see. It is available only while the session is retained, which is why
			 * the forwarded message stays the primary source of the wording.
			 *
			 * The read is bounded by time, and that bound is what makes it safe to
			 * trust: the follow stream can still be delivering an older turn's
			 * `turn/end` when the status edge arrives, and treating that stale ending
			 * as this finish would both invent a failure and bury a real completion.
			 * Only an ending recorded within the same window as a forwarded failure
			 * can belong to the finish being reported.
			 * @param sessionId - the session that just stopped running.
			 * @returns the verdict and the reason text; a failed verdict with empty
			 * detail still means "this turn failed, wording unavailable".
			 */
			const reasonOf = (sessionId) => {
				const none = { failed: false, detail: '' };
				try {
					const binding = ctx.sessions.binding(sessionId);
					if (binding === undefined) return none;
					const entries = binding.eventSource.getSnapshot().entries ?? [];
					const now = Date.now();
					for (let i = entries.length - 1; i >= 0; i -= 1) {
						const event = entries[i]?.event;
						if (event?.type !== 'turn/end') continue;
						// A missing timestamp cannot be bounded, so it is not trusted.
						if (typeof event.time !== 'number' || now - event.time > ERROR_WINDOW_MS) return none;
						return classifyTurnEnd(event.data?.reason);
					}
					return none;
				} catch (error) {
					console.warn('[completion-alert] turn reason read failed:', error);
					return none;
				}
			};

			const detector = createDetector({
				getSettings: () => settingsStore.getSnapshot(),
				emit: notify,
				isEligible,
				reasonOf,
			});
			ctx.effect(() => {
				// Seed from the list first: the Host publishes status transitions, so a
				// session already running at load time is only discoverable this way.
				try {
					detector.seed(ctx.sessions.list.getSnapshot().byId ?? {});
				} catch (error) {
					console.warn('[completion-alert] baseline seed failed:', error);
				}
				const offStatus = ctx.remote.$on('api-session/status', (sessionId, running) => detector.onStatus(sessionId, running));
				const offError = ctx.remote.$on('api-session/error', (sessionId, message) => detector.onError(sessionId, message));
				return () => {
					offStatus();
					offError();
					detector.reset();
				};
			}, 'completion-alert: host status subscription');

			ctx.effect(() => {
				const tagId = '@local/dsh-completion-alert/alert.css';
				if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return () => {};
				const tag = document.createElement('style');
				tag.dataset.plugin = '@local/dsh-completion-alert';
				tag.dataset.pluginCss = tagId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, 'completion-alert: stylesheet');

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'completion-alert: dictionaries');

			// Notification permission is requested only from an explicit user gesture
			// (the settings switch or its grant button); browsers suppress an
			// ungestured prompt, so asking at load would be noise.

			const previewSound = (kind, detail, code) => {
				audio.unlock();
				audio.preview(kind, settingsStore.getSnapshot().sound.mode, detail, code);
			};
			const resetSettings = () => {
				const previous = settingsStore.getSnapshot().sound.roles;
				const next = defaultSettings();
				settingsStore.set(next);
				persistSettings(next);
				badge.clearAll();
				// Resetting drops every role from the settings, so its clips would be
				// orphaned in IndexedDB with nothing left to reference or delete them.
				void Promise.all(previous.flatMap((role) => (
					KINDS.map((kind) => clips.remove('role:' + role.id + ':' + kind))
				))).catch(() => { /* best-effort cleanup */ });
			};

			// `shell.overlay` is root-scoped, so the standard kit already hands this
			// component `useSessionStatus`; only the callback this plugin owns is
			// injected.
			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'completion-alert.watcher',
				order: 90,
				locale: NS,
				inject: () => ({ notifyWaiting }),
			}, AlertHost));

			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'completion-alert',
				order: 60,
				label: () => t('page.nav'),
				locale: NS,
				inject: () => ({
					hooks: {
						settings: settingsStore,
						nativeState: native.state,
						soundBlocked: soundBlockedStore,
						voices: audio.voices,
					},
					updateSettings,
					previewAlert,
					// Not rendered as its own control any more; kept on the inject surface
					// so the sound channel can be exercised in isolation.
					previewSound,
					previewClip: audio.previewKey,
					setRoleClip,
					clearRoleClip,
					addRole,
					removeRole,
					renameRole,
					moveRole,
					resetSettings,
					requestNativePermission: native.request,
					badgeSupported: badge.supported(),
					// Shown as the language field's placeholder, so an empty field
					// advertises exactly which tag it will fall back to.
					localeTag: activeLocale(),
				}),
			}, SettingsPage));

			ctx.slots.inject('settings.general.item', () => ctx.slots.register({
				name: 'settings.general.item',
				id: 'completion-alert-master',
				order: 40,
				locale: NS,
				inject: () => ({
					hooks: { settings: settingsStore },
					updateSettings,
				}),
			}, GeneralRow));
		}
		//#endregion

		//#region locales
		/** Simplified Chinese dictionary (key-set source of truth). */
		const zh = {
			'page.nav': '任务提醒',
			'page.title': '任务完成提醒',
			'page.subtitle': '对话任务结束时，用提示音和屏幕右下角的通知提醒你，即使你正在使用其他应用、或把 DSH 最小化了。',
			'page.footer': '关闭上方总开关即可一键停用全部提醒；提示音与通知分别控制，互不影响。',
			'general.hint': '一键开启或关闭任务完成提醒。',
			'group.master': '总开关',
			'group.preview': '预览',
			'group.events': '提醒状态',
			'group.sound': '提示音',
			'group.notify': '提醒方式',
			'preview.alert': '预览提醒效果',
			'preview.alert.hint': '按真实提醒的效果演示：播放提示音，并弹出屏幕右下角的系统通知。',
			'preview.task': '示例任务：整理季度报告',
			'preview.error': '示例原因：模型请求失败（520）',
			'master.enabled': '启用任务提醒',
			'master.enabled.hint': '关闭后不再播放提示音，也不再弹出任何通知。',
			'master.subagents': '包含子任务',
			'master.subagents.hint': '子代理结束时也提醒。默认只提醒主对话。',
			'master.reset': '恢复默认设置',
			'master.reset.hint': '清空全部自定义内容，回到初始状态。',
			'kind.done.title': '任务已完成',
			'kind.done.hint': '对话正常结束、等待你下一步指令时提醒。',
			'kind.done.body': '对话已结束，可以查看结果了。',
			'kind.error.title': '任务异常中断',
			'kind.error.hint': '对话因错误终止时提醒，并带上具体原因。',
			'kind.error.body': '对话出现错误，建议检查一下。',
			'kind.waiting.title': '等待你的回答',
			'kind.waiting.hint': '助手提问或请求授权、需要你操作时提醒。',
			'kind.waiting.body': '助手正在等待你的回答。',
			'waiting.question': '助手向你提出了一个问题。',
			'waiting.approval': '助手请求你的授权。',
			'waiting.plan': '助手提交了计划，等待你确认。',
			'notify.native': '系统通知（屏幕右下角）',
			'notify.native.hint': '由操作系统在屏幕右下角弹出，最小化 DSH 后仍能看到。颜色由系统控制，三种状态用符号区分：✅ 完成、⚠️ 异常、❓ 等待。',
			'notify.native.ask': '需要你授权后才能发送系统通知。',
			'notify.native.denied': '系统通知已被拒绝，请在浏览器或系统设置中允许本应用通知。',
			'notify.native.unsupported': '当前环境不支持系统通知，此项不可用。',
			'notify.native.grant': '授权通知',
			'notify.badge': '任务栏数字角标',
			'notify.badge.hint': '在任务栏的 DSH 图标上显示「还没看过的对话」数量，最小化窗口时也能看到。你在 DSH 里打开该对话后，数字才会减 1；减到 0 时角标消失。',
			'notify.badge.unsupported': '当前环境不支持任务栏角标，此项不可用。',
			'sound.mode': '提示音方式',
			'sound.mode.hint.tone': '三种状态使用各自不同的音色与节奏，便于分辨。',
			'sound.mode.hint.tts': '朗读你填写的文字，三种状态可以分别设置内容。',
			'sound.mode.hint.audio': '三种状态播放同一段音频。',
			'sound.mode.hint.none': '不播放任何声音。',
			'sound.mode.tone': '内置音效',
			'sound.mode.tts': '语音朗读',
			'sound.mode.audio': '自定义音频',
			'sound.mode.none': '静音',
			'sound.silent': '已选择静音',
			'sound.silent.hint': '任务结束时不会有任何声音。弹窗与系统通知仍按下方设置工作。',
			'sound.volume': '音量',
			'sound.blocked': '提示音已被浏览器暂停：请在本页面点击任意位置一次，之后即可正常播放。',
			'sound.tts.text': '朗读文字',
			'sound.tts.text.hint': '为每种状态分别填写要朗读的文字。留空则使用占位符里的默认说法，跟随界面语言。',
			'sound.tts.default.done': '任务已完成',
			'sound.tts.default.error': '任务出现异常',
			'sound.tts.default.waiting': '等待你的回答',
			'sound.tts.reason': '异常原因朗读',
			'sound.tts.reason.hint': '按异常类型分别设置要朗读的提示语，留空则使用下方的默认文案。右侧按钮可按该类型的示例试听。',
			'sound.tts.raw': '同时朗读原始错误信息',
			'sound.tts.raw.hint': '在提示语之后，再念出接口返回的原始错误信息（过长会截断）。中转站的报错通常较技术化，建议保持关闭。',
			'reason.play': '试听',
			'reason.auth.name': '认证失败',
			'reason.auth': '接口密钥无效或未授权',
			'reason.quota.name': '额度不足',
			'reason.quota': '账户额度已用尽',
			'reason.rate.name': '请求过快',
			'reason.rate': '请求过于频繁，已被限流',
			'reason.server.name': '服务端错误',
			'reason.server': '服务端返回错误，可能是上游故障',
			'reason.network.name': '连接中断',
			'reason.network': '连接中断或超时',
			'reason.endpoint.name': '地址或模型错误',
			'reason.endpoint': '接口地址或模型名不正确',
			'reason.malformed.name': '返回异常',
			'reason.malformed': '返回内容异常，无法解析',
			'reason.context.name': '上下文超限',
			'reason.context': '对话内容超出模型上下文长度',
			'reason.request.name': '请求被拒',
			'reason.request': '请求参数被拒绝',
			'reason.unknown.name': '其他错误',
			'reason.unknown': '错误原因未识别',
			'sound.tts.voice': '朗读音色',
			'sound.tts.voice.hint': '选择系统中已安装的语音。',
			'sound.tts.voice.empty': '系统尚未返回可用语音，可稍后重新打开本页。',
			'sound.tts.voice.auto': '自动（按语言选择）',
			'sound.tts.lang': '朗读语言 / 语速',
			'sound.tts.lang.hint': '语言代码，例如 zh-CN、en-US。留空则跟随界面语言；音色选「自动」时按此选择语音。',
			'sound.tts.rate': '语速',
			'sound.tts.lead': '开头留白（毫秒）',
			'sound.tts.lead.hint': '朗读前先静音一小段，等语音引擎升到正常音量，第一个字就不会被吞掉。默认 350。',
			'role.title': '角色语音',
			'role.hint': '每个角色可分别设置三种状态的语音。同一种状态有多个角色时，列表中靠上的角色优先；未设置的由内置音效补上。',
			'role.empty': '还没有角色。在下方输入名称即可添加，例如「初音未来」。',
			'role.name': '角色名称',
			'role.name.placeholder': '例如：初音未来',
			'role.add': '添加角色',
			'role.add.hint': '为一段语音起个名字。同名角色不会重复添加。',
			'role.add.action': '添加',
			'role.remove': '删除',
			'role.up': '上移（提高优先级）',
			'role.down': '下移（降低优先级）',
			'role.clip.set': '已设置',
			'role.clip.unset': '未设置',
			'role.play': '试听',
			'role.clear': '清除',
			'role.tooLarge': '音频文件过大，请选择小于 768 KB 的短音频（约 10 秒）。',
			'role.failed': '保存音频失败，请重试。',
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			'page.nav': 'Task Alerts',
			'page.title': 'Task Completion Alerts',
			'page.subtitle': 'When a conversation task finishes, an alert sound and a notification in the corner of your screen tell you — even while you are using another application, or with DSH minimised.',
			'page.footer': 'Turn off the master switch to disable every alert at once; sound and notifications are controlled separately.',
			'general.hint': 'One-click switch for task completion alerts.',
			'group.master': 'Master',
			'group.preview': 'Preview',
			'group.events': 'Finish states',
			'group.sound': 'Alert sound',
			'group.notify': 'How you are told',
			'preview.alert': 'Preview a full alert',
			'preview.alert.hint': 'Reproduces a real alert: plays the sound and raises the screen notification.',
			'preview.task': 'Sample task: tidy the quarterly report',
			'preview.error': 'Sample reason: the model request failed (520)',
			'master.enabled': 'Enable task alerts',
			'master.enabled.hint': 'When off, no sound plays and no notice appears.',
			'master.subagents': 'Include subagents',
			'master.subagents.hint': 'Also alert when a subagent finishes. Only the main conversation alerts by default.',
			'master.reset': 'Restore defaults',
			'master.reset.hint': 'Clear every customization and return to the initial state.',
			'kind.done.title': 'Task completed',
			'kind.done.hint': 'Alerts when a conversation ends normally and awaits your next instruction.',
			'kind.done.body': 'The conversation finished; the result is ready.',
			'kind.error.title': 'Task interrupted',
			'kind.error.hint': 'Alerts when a conversation terminates with an error, including the concrete reason.',
			'kind.error.body': 'The conversation hit an error; you may want to check it.',
			'kind.waiting.title': 'Waiting for your answer',
			'kind.waiting.hint': 'Alerts when the assistant asks a question or requests authorization.',
			'kind.waiting.body': 'The assistant is waiting for your answer.',
			'waiting.question': 'The assistant asked you a question.',
			'waiting.approval': 'The assistant requested your authorization.',
			'waiting.plan': 'The assistant submitted a plan for your confirmation.',
			'notify.native': 'System notification (screen corner)',
			'notify.native.hint': 'Raised by the operating system in the corner of your screen, so it still appears with DSH minimised. The OS owns its colours; the three states are marked \u2705 done, \u26a0\ufe0f error, \u2753 waiting.',
			'notify.native.ask': 'Permission is required before system notifications can be sent.',
			'notify.native.denied': 'System notifications are blocked; allow notifications for this app in your browser or system settings.',
			'notify.native.unsupported': 'This environment does not support system notifications; this option is unavailable.',
			'notify.native.grant': 'Grant permission',
			'notify.badge': 'Taskbar number badge',
			'notify.badge.hint': 'Shows how many conversations finished and have not been looked at, on the DSH taskbar icon — visible while the window is minimised. Opening such a conversation in DSH drops the count by one, and zero clears the badge.',
			'notify.badge.unsupported': 'This environment does not support a taskbar badge; this option is unavailable.',
			'sound.mode': 'Sound channel',
			'sound.mode.hint.tone': 'Each finish state uses its own tone and rhythm, so they are easy to tell apart.',
			'sound.mode.hint.tts': 'Reads out the text you write; each state can say something different.',
			'sound.mode.hint.audio': 'The same clip plays for all three states.',
			'sound.mode.hint.none': 'No sound is played.',
			'sound.mode.tone': 'Built-in tone',
			'sound.mode.tts': 'Spoken text',
			'sound.mode.audio': 'Custom audio',
			'sound.mode.none': 'Silent',
			'sound.silent': 'Silent is selected',
			'sound.silent.hint': 'Nothing will be played when a task finishes. The notice card and system notification still follow the settings below.',
			'sound.volume': 'Volume',
			'sound.blocked': 'The browser has paused alert sounds: click once anywhere on this page to enable playback.',
			'sound.tts.text': 'Spoken text',
			'sound.tts.text.hint': 'One phrase per finish state, read aloud. Leave a field empty to use the default shown in its placeholder, which follows the interface language.',
			'sound.tts.default.done': 'The task is finished',
			'sound.tts.default.error': 'The task ran into a problem',
			'sound.tts.default.waiting': 'Waiting for your answer',
			'sound.tts.reason': 'Spoken error reason',
			'sound.tts.reason.hint': 'Set your own phrase per error type; leave a field empty to use the default below. The button on the right previews that type.',
			'sound.tts.raw': 'Also read the raw error message',
			'sound.tts.raw.hint': 'Read the provider\'s original message after the phrase (shortened when long). Relay-station errors are usually too technical to listen to, so this stays off.',
			'reason.play': 'Test',
			'reason.auth.name': 'Authentication',
			'reason.auth': 'The API key is invalid or unauthorized',
			'reason.quota.name': 'Quota',
			'reason.quota': 'The account quota is exhausted',
			'reason.rate.name': 'Rate limit',
			'reason.rate': 'Too many requests, rate limited',
			'reason.server.name': 'Server error',
			'reason.server': 'The server returned an error, possibly upstream',
			'reason.network.name': 'Connection',
			'reason.network': 'The connection dropped or timed out',
			'reason.endpoint.name': 'Wrong address or model',
			'reason.endpoint': 'The endpoint address or the model name is wrong',
			'reason.malformed.name': 'Bad response',
			'reason.malformed': 'The response was malformed and could not be parsed',
			'reason.context.name': 'Context limit',
			'reason.context': 'The conversation exceeds the model context length',
			'reason.request.name': 'Rejected request',
			'reason.request': 'The request parameters were rejected',
			'reason.unknown.name': 'Other errors',
			'reason.unknown': 'the reason was not recognised',
			'sound.tts.voice': 'Voice',
			'sound.tts.voice.hint': 'Pick one of the voices installed on this system.',
			'sound.tts.voice.empty': 'The system has not reported any voices yet; reopen this page in a moment.',
			'sound.tts.voice.auto': 'Automatic (by language)',
			'sound.tts.lang': 'Language / rate',
			'sound.tts.lang.hint': 'A language tag such as zh-CN or en-US. Leave it empty to follow the interface language; used to choose a voice when Voice is Automatic.',
			'sound.tts.rate': 'Speech rate',
			'sound.tts.lead': 'Leading silence (ms)',
			'sound.tts.lead.hint': 'Stay silent briefly before speaking so the engine reaches full volume; this stops the first word being swallowed. Default 350.',
			'role.title': 'Character voices',
			'role.hint': 'Each character can supply any of the three finish states. When several characters fill one state, the higher entry wins; anything unset falls back to the built-in tone.',
			'role.empty': 'No characters yet. Add one by typing a name below.',
			'role.name': 'Character name',
			'role.name.placeholder': 'e.g. Hatsune Miku',
			'role.add': 'Add a character',
			'role.add.hint': 'Name a set of clips. A name already in the list is not added twice.',
			'role.add.action': 'Add',
			'role.remove': 'Remove',
			'role.up': 'Move up (higher priority)',
			'role.down': 'Move down (lower priority)',
			'role.clip.set': 'Set',
			'role.clip.unset': 'Not set',
			'role.play': 'Play',
			'role.clear': 'Clear',
			'role.tooLarge': 'That audio file is too large; pick a short clip under 768 KB (about 10 seconds).',
			'role.failed': 'Saving the audio failed; please retry.',
		};
		//#endregion

		return { inject, apply };
	},
});
