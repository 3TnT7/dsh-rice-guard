// 配置按会话冻结，面板不能暗示开关会改写当前会话的前缀。
const STATS_PATH = "/api/rice-guard/stats";
const CONFIG_PATH = "/api/rice-guard/config";
const TUNING_PATH = "/api/rice-guard/tuning";
const PANEL_ID = "rice-guard";
const NS = "riceGuard";

window.__ModuleLoader__.load({
	id: "dsh-rice-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const h = React.createElement;
		const { useEffect, useState, useCallback, useRef } = React;
		const CSS = `
.rg-panel{display:flex;flex-direction:column;gap:20px;padding:28px 32px;max-width:760px;box-sizing:border-box;min-width:0;width:100%;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5;overflow:auto;height:100%}
.rg-panel *{box-sizing:border-box}
.rg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.rg-title{margin:0;font-size:20px;font-weight:600;letter-spacing:.2px}
.rg-sub{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;overflow-wrap:anywhere}
.rg-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.rg-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:14px 16px;min-width:0}
.rg-card-label{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-bottom:6px}
.rg-card-value{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.3;overflow-wrap:anywhere}
.rg-card-note{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:4px}
.rg-section-title{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rg-rows{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.rg-row{display:flex;justify-content:space-between;gap:16px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.rg-row:first-child{border-top:0}
.rg-row-key{color:var(--dsw-alias-label-tertiary)}
.rg-row-value{font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere;min-width:0}
.rg-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rg-actions,.rg-tabs{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rg-tabs{border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:10px}
.rg-btn{font:inherit;color:inherit;cursor:pointer;padding:5px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent}
.rg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rg-btn[aria-selected="true"],.rg-btn[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-state-business-primary)}
.rg-muted,.rg-notice{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap}
.rg-error{color:var(--dsw-alias-state-error-primary);font-size:13px;overflow-wrap:anywhere;white-space:pre-wrap}
.rg-switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.rg-switch-row:first-child{border-top:0}
.rg-switch-text{display:flex;flex-direction:column;gap:2px;min-width:0;overflow-wrap:anywhere}
.rg-switch-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:pre-wrap}
.rg-switch{position:relative;width:38px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;flex:none;padding:0}
.rg-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .15s ease,background .15s ease}
.rg-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary);border-color:transparent}
.rg-switch[aria-checked="true"]::after{transform:translateX(16px);background:var(--dsw-alias-bg-layer-1)}
.rg-switch:disabled,.rg-btn:disabled,.rg-input:disabled{opacity:.5;cursor:default}
.rg-pending{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.rg-confirm{padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}
.rg-ledger summary,.rg-advanced summary{cursor:pointer}
.rg-ledger-list{margin:8px 0 0;padding:0;list-style:none}
.rg-ledger-list li{padding:6px 0;overflow-wrap:anywhere;border-top:1px solid var(--dsw-alias-border-l1)}
.rg-stack{display:flex;flex-direction:column;gap:16px;min-width:0}
.rg-scroll{overflow:auto;max-width:100%;max-height:360px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.rg-table{border-collapse:collapse;min-width:660px;width:100%;font-size:12px;font-variant-numeric:tabular-nums}
.rg-table th,.rg-table td{padding:8px 10px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rg-table th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-1)}
.rg-field{padding:14px 16px;border-top:1px solid var(--dsw-alias-border-l1);min-width:0;overflow-wrap:anywhere}
.rg-field:first-child{border-top:0}
.rg-field-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.rg-input{font:inherit;width:100%;min-width:0;max-width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
textarea.rg-input{min-height:100px;resize:vertical;font-family:monospace;white-space:pre;overflow:auto}
.rg-advanced{padding:10px 0}
.rg-risk-high{color:var(--dsw-alias-state-error-primary)}
`;
		function injectStyles() {
			if (document.getElementById("rg-styles")) return;
			const el = document.createElement("style");
			el.id = "rg-styles";
			el.textContent = CSS;
			document.head.appendChild(el);
		}
		function formatNumber(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return value.toLocaleString("zh-CN");
		}
		function formatBytes(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			const units = ["B", "KB", "MB", "GB"];
			let n = Math.abs(value);
			let unit = 0;
			while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit += 1; }
			return `${value < 0 ? "-" : ""}${n.toLocaleString("zh-CN", { maximumFractionDigits: unit === 0 || n >= 10 ? 0 : 1 })} ${units[unit]}`;
		}
		function formatText(value) { return typeof value === "string" || typeof value === "boolean" ? String(value) : "—"; }
		function formatList(value, empty) { return Array.isArray(value) ? value.filter((item) => typeof item === "string").join(", ") || empty : "—"; }
		function formatPercent(value) { return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—"; }
		function formatMoney(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			if (value === 0) return "¥0";
			return Math.abs(value) < 0.01 ? `¥${value.toFixed(6)}` : `¥${value.toFixed(2)}`;
		}
		function ratioOf(before, after) {
			return typeof before === "number" && typeof after === "number" && Number.isFinite(before) && Number.isFinite(after) && before > 0 ? 1 - after / before : undefined;
		}
		function asObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
		function list(value) { return Array.isArray(value) ? value : []; }
		function display(value) {
			if (value === undefined) return "—";
			return typeof value === "string" ? value : JSON.stringify(value);
		}
		function getPath(value, path) { return String(path).split(".").reduce((node, key) => asObject(node)[key], value); }
		function setPath(target, path, value) {
			const keys = String(path).split(".");
			// 即使旧宿主的元数据有误，也不能让路径修改对象原型。
			if (keys.some((key) => !key || ["__proto__", "prototype", "constructor"].includes(key))) throw new Error("不安全的配置路径");
			let node = target;
			keys.slice(0, -1).forEach((key) => { node[key] = asObject(node[key]); node = node[key]; });
			node[keys[keys.length - 1]] = value;
		}
		function formatTime(value, timezone) {
			if (value === undefined || value === null) return "—";
			const date = new Date(value);
			if (!Number.isFinite(date.getTime())) return "—";
			try { return date.toLocaleString("zh-CN", timezone ? { timeZone: timezone, hour12: false } : { hour12: false }); }
			catch { return date.toLocaleString("zh-CN", { hour12: false }); }
		}
		function timingLabel(timing) { return ({ "new-session": "新会话生效", immediate: "立即生效", "display-only": "仅展示" })[timing] || "生效时机未提供"; }
		function recommended(meta) {
			if (meta.recommended !== undefined) return display(meta.recommended);
			return meta.min !== undefined || meta.max !== undefined ? `${meta.min ?? "不限"} ～ ${meta.max ?? "不限"}${meta.unit || ""}` : "—";
		}
		async function request(url, payload, signal) {
			const res = await fetch(url, {
				method: payload === undefined ? "GET" : "POST", cache: "no-store", signal,
				headers: { accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }) },
				...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
			});
			const body = await res.json().catch(() => null);
			if (!res.ok || !body || body.ok === false) throw new Error(body && (body.error || body.message) ? display(body.error || body.message) : `HTTP ${res.status}${body ? "" : "：响应不是有效 JSON"}`);
			return asObject(body);
		}
		function Card({ label, value, note }) {
			return h("div", { className: "rg-card" }, h("div", { className: "rg-card-label" }, label), h("div", { className: "rg-card-value" }, value), note ? h("div", { className: "rg-card-note" }, note) : null);
		}
		function Row({ label, value }) {
			return h("div", { className: "rg-row" }, h("span", { className: "rg-row-key" }, label), h("span", { className: "rg-row-value" }, value));
		}
		function Switch({ label, hint, checked, disabled, pending, onChange }) {
			return h("div", { className: "rg-switch-row" },
				h("span", { className: "rg-switch-text" }, h("span", null, label, pending ? "（待确认，再点一次）" : ""), h("span", { className: "rg-switch-hint" }, hint)),
				h("button", { type: "button", className: `rg-switch${pending ? " rg-pending" : ""}`, role: "switch", "aria-checked": String(checked === true), "aria-label": `${label}${pending ? "，待确认，再点一次" : ""}`, disabled, onClick: onChange }));
		}
		function RiceGuardIcon({ size = 16, active = false }) {
			return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: active ? 2 : 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("path", { d: "M12 3c3.6 2.3 5.4 5.1 5.4 8.4 0 3.7-2.4 6.9-5.4 8.6-3-1.7-5.4-4.9-5.4-8.6C6.6 8.1 8.4 5.3 12 3z" }), h("path", { d: "M12 7.5v9" }), h("path", { d: "M9.6 12.2 12 9.8l2.4 2.4" }));
		}
		function encodeValue(meta, value) {
			if (meta.kind === "boolean") return value === true;
			if (meta.kind === "stringList") return list(value).join("\n");
			if (meta.kind === "object") return value === undefined ? "" : JSON.stringify(value, null, 2);
			return value === undefined || value === null ? "" : String(value);
		}
		function parseValue(meta, raw) {
			if (meta.kind === "boolean") return raw === true;
			if (meta.kind === "number") {
				if (String(raw).trim() === "" || !Number.isFinite(Number(raw))) throw new Error("请输入有限数字");
				const value = Number(raw);
				if (meta.min !== undefined && value < meta.min) throw new Error(`不能小于 ${meta.min}`);
				if (meta.max !== undefined && value > meta.max) throw new Error(`不能大于 ${meta.max}`);
				return value;
			}
			if (meta.kind === "stringList") {
				const value = String(raw).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
				if (typeof meta.maxEntries === "number" && value.length > meta.maxEntries) throw new Error(`最多 ${meta.maxEntries} 条`);
				return value;
			}
			if (meta.kind === "object") {
				let value;
				try { value = JSON.parse(raw); } catch { throw new Error("JSON 格式无效"); }
				if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error("请输入 JSON 对象或 null");
				if (meta.path === "pricing.override" && value !== null && (!["hit", "miss", "out"].every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !["hit", "miss", "out"].includes(key)))) throw new Error("价表应为 null 或包含 hit、miss、out 的对象");
				return value;
			}
			if (meta.kind === "enum") {
				const option = list(meta.options).find((item) => String(typeof item === "object" && item !== null ? item.value : item) === raw);
				if (option === undefined) throw new Error("请选择可用选项");
				return typeof option === "object" && option !== null ? option.value : option;
			}
			return String(raw);
		}
		function RiceGuardPanel() {
			const [tab, setTab] = useState("stats");
			const [windowKey, setWindowKey] = useState("d30");
			const [data, setData] = useState({});
			const [tuning, setTuning] = useState({});
			const [draft, setDraft] = useState({});
			const [statsLoading, setStatsLoading] = useState(false);
			const [tuningLoading, setTuningLoading] = useState(false);
			const [saving, setSaving] = useState(false);
			const [statsError, setStatsError] = useState("");
			const [tuningError, setTuningError] = useState("");
			const [notice, setNotice] = useState("");
			const [pending, setPending] = useState(null);
			const alive = useRef(false);
			const savingRef = useRef(false);
			const dirtyRef = useRef(false);
			const confirmTimer = useRef(null);
			const pendingRef = useRef(null);
			const statsSequence = useRef(0);
			const tuningSequence = useRef(0);
			const statsAbort = useRef(null);
			const tuningAbort = useRef(null);
			const clearPending = useCallback(() => {
				clearTimeout(confirmTimer.current);
				pendingRef.current = null;
				setPending(null);
			}, []);
			useEffect(() => {
				alive.current = true;
				return () => {
					alive.current = false;
					clearTimeout(confirmTimer.current);
					statsAbort.current?.abort();
					tuningAbort.current?.abort();
				};
			}, []);
			const loadStats = useCallback(async (poll = false) => {
				// 慢请求应能完成，不能每五秒被下一轮轮询打断。
				if (savingRef.current || (poll && statsAbort.current && !statsAbort.current.signal.aborted)) return;
				const sequence = ++statsSequence.current;
				statsAbort.current?.abort();
				const controller = new AbortController();
				statsAbort.current = controller;
				setStatsLoading(true);
				try {
					const body = await request(`${STATS_PATH}?window=${windowKey}`, undefined, controller.signal);
					if (alive.current && sequence === statsSequence.current) { setData(body); setStatsError(""); }
				} catch (error) {
					if (alive.current && sequence === statsSequence.current && error.name !== "AbortError") setStatsError(error.message || String(error));
				} finally {
					if (sequence === statsSequence.current) {
						statsAbort.current = null;
						if (alive.current) setStatsLoading(false);
					}
				}
			}, [windowKey]);
			const loadTuning = useCallback(async (force = false) => {
				const sequence = ++tuningSequence.current;
				tuningAbort.current?.abort();
				const controller = new AbortController();
				tuningAbort.current = controller;
				setTuningLoading(true);
				try {
					const body = await request(TUNING_PATH, undefined, controller.signal);
					if (alive.current && sequence === tuningSequence.current) {
						// 离开页签不代表放弃编辑，重新进入也不能覆盖尚未保存的基线。
						if (force || !dirtyRef.current) setTuning(body);
						setTuningError("");
					}
				} catch (error) {
					if (alive.current && sequence === tuningSequence.current && error.name !== "AbortError") setTuningError(error.message || String(error));
				} finally { if (alive.current && sequence === tuningSequence.current) setTuningLoading(false); }
			}, []);
			useEffect(() => {
				if (tab === "stats") {
					void loadStats();
					const timer = setInterval(() => { void loadStats(true); }, 5000);
					return () => { clearInterval(timer); statsAbort.current?.abort(); };
				}
				if (tab === "config") void loadStats();
				void loadTuning();
			}, [tab, loadStats, loadTuning]);

			const config = asObject(data.config);
			const metas = list(tuning.meta).length ? list(tuning.meta) : list(data.meta || config.meta);
			const validMetas = metas.filter((meta) => meta && typeof meta.path === "string");
			const effective = asObject(tuning.effective);
			const edits = [];
			const errors = {};
			validMetas.forEach((meta) => {
				if (!Object.hasOwn(draft, meta.path) || meta.editable === false || meta.timing === "display-only") return;
				try {
					const value = parseValue(meta, draft[meta.path]);
					if (JSON.stringify(value) !== JSON.stringify(getPath(effective, meta.path))) edits.push({ path: meta.path, value });
				} catch (error) { errors[meta.path] = error.message; }
			});
			const dirty = edits.length > 0 || Object.keys(errors).length > 0;
			dirtyRef.current = dirty;
			const busy = saving || statsLoading || tuningLoading;
			const storage = asObject(tab === "stats" ? data.storage : tuning.storage || data.storage);
			const dir = tab === "stats" ? storage.dir : tuning.dir || storage.dir || asObject(data.storage).dir;
			const configKey = JSON.stringify(config);
			useEffect(() => { if (pendingRef.current?.scope === "config") clearPending(); }, [configKey, clearPending]);
			const confirm = (id, scope, action) => {
				if (savingRef.current || busy) return;
				const previous = pendingRef.current;
				if (previous?.id === id && previous.scope === scope && Date.now() < previous.deadline) {
					clearPending();
					void action();
					return;
				}
				clearPending();
				const next = { id, scope, deadline: Date.now() + 5000 };
				pendingRef.current = next;
				setPending(next);
				confirmTimer.current = setTimeout(clearPending, 5000);
			};
			const mutate = async (url, payload, isConfig = false) => {
				if (savingRef.current) return;
				// React 渲染前也要锁写入，避免快速连点重复创建备份。
				savingRef.current = true;
				statsSequence.current += 1;
				tuningSequence.current += 1;
				statsAbort.current?.abort();
				tuningAbort.current?.abort();
				setSaving(true);
				setNotice("");
				try {
					const body = await request(url, payload);
					if (!alive.current) return;
					if (isConfig) setData((previous) => ({ ...previous, config: body.config || previous.config }));
					else { setTuning(body); setDraft({}); dirtyRef.current = false; }
					setNotice(`已保存${body.backupId ? `；备份 ${body.backupId}` : ""}${list(body.warnings).length ? `\n警告：${body.warnings.map(display).join("；")}` : ""}`);
					await loadTuning(true);
				} catch (error) {
					if (alive.current) setNotice(`操作失败：${error.message || String(error)}`);
				} finally {
					savingRef.current = false;
					if (alive.current) { setSaving(false); setStatsLoading(false); setTuningLoading(false); }
				}
			};
			const requestChange = (id, payload, needsConfirm) => {
				if (needsConfirm) confirm(id, "config", () => mutate(CONFIG_PATH, payload, true));
				else { clearPending(); if (!busy) void mutate(CONFIG_PATH, payload, true); }
			};
			const discard = () => { clearPending(); setDraft({}); dirtyRef.current = false; };
			const switchControl = (group, key, fallback, hint) => {
				const path = `${group}.${key}`;
				const meta = validMetas.find((item) => item.path === path);
				const value = getPath(config, path);
				const description = meta ? `${meta.summary || hint}\n影响：${display(meta.impact)}；默认：${display(meta.default)}；推荐：${recommended(meta)}；${timingLabel(meta.timing)}` : hint;
				return h(Switch, { key: path, label: meta?.label || fallback,
					hint: `${description}\n新会话生效${typeof value !== "boolean" ? "（当前宿主未提供此字段）" : ""}`,
					checked: value, disabled: busy || dirty || typeof value !== "boolean", pending: pending?.id === path,
					onChange: () => requestChange(path, { [group]: { [key]: !value } }, key === "enabled") });
			};
			const preset = (id, label, enabled) => h("button", {
				key: id, type: "button", className: `rg-btn${pending?.id === id ? " rg-pending" : ""}`,
				disabled: busy || dirty || typeof getPath(config, "truncation.enabled") !== "boolean" || typeof getPath(config, "ordering.enabled") !== "boolean",
				onClick: () => requestChange(id, { truncation: { enabled }, ordering: { enabled: true } }, true),
			}, `${label}${pending?.id === id ? "（再点确认）" : ""}`);
			const editField = (meta) => {
				const raw = Object.hasOwn(draft, meta.path) ? draft[meta.path] : encodeValue(meta, getPath(effective, meta.path));
				const disabled = busy || meta.editable === false || meta.timing === "display-only";
				const update = (value) => { clearPending(); setDraft((previous) => ({ ...previous, [meta.path]: value })); };
				const props = { id: `rg-field-${meta.path}`, className: "rg-input", disabled, value: raw, "aria-label": meta.label || meta.path, "aria-invalid": !!errors[meta.path], onChange: (event) => update(event.target.value), placeholder: meta.placeholder };
				let editor;
				if (meta.kind === "boolean") editor = h(Switch, { label: meta.label || meta.path, checked: raw, disabled, onChange: () => update(!raw) });
				else if (meta.kind === "enum") {
					const options = list(meta.options).map((option) => typeof option === "object" && option !== null ? option : { value: option, label: String(option) });
					editor = h("select", props,
						!options.some((option) => String(option.value) === raw) ? h("option", { value: raw }, raw || "请选择") : null,
						options.map((option) => h("option", { key: String(option.value), value: String(option.value) }, option.label || String(option.value))));
				} else if (meta.kind === "stringList" || meta.kind === "object") editor = h("textarea", { ...props, rows: 4, spellCheck: false });
				else editor = h("input", { ...props, type: meta.kind === "number" ? "number" : "text", ...(meta.kind === "number" ? { min: meta.min, max: meta.max, step: meta.step ?? "any" } : {}) });
				return h("div", { className: "rg-field", key: meta.path },
					h("div", { className: "rg-field-head" }, h("label", { htmlFor: `rg-field-${meta.path}` }, meta.label || meta.path),
						h("span", { className: `rg-pill rg-risk-${meta.risk || "low"}` }, `风险：${({ low: "低", medium: "中", high: "高" })[meta.risk] || "未知"}`), h("span", { className: "rg-pill" }, timingLabel(meta.timing))),
					h("div", { className: "rg-muted" }, meta.path, meta.summary ? ` · ${meta.summary}` : ""), editor,
					errors[meta.path] ? h("div", { className: "rg-error", role: "alert" }, errors[meta.path]) : null,
					h("div", { className: "rg-muted" }, `默认：${display(meta.default)}；推荐范围：${recommended(meta)}${meta.unit ? `；单位：${meta.unit}` : ""}\n影响：${display(meta.impact)}${meta.kind === "stringList" ? "；每行一条" : ""}${meta.editable === false ? "；只读" : ""}`));
			};

			const selected = asObject(asObject(data.windows)[windowKey]);
			const windowLabels = { today: "今天", d7: "最近 7 天", d30: "最近 30 天" };
			const hasWindow = !!asObject(data.windows)[windowKey];
			const pricing = asObject(data.pricing);
			const priceEntry = asObject(pricing.entry);
			const priceOf = (kind, tier) => {
				const value = asObject(priceEntry[kind])[tier];
				return typeof value === "number" && Number.isFinite(value) ? value : undefined;
			};
			const money = (tokens, tier, kind) => typeof tokens === "number" && typeof priceOf(kind, tier) === "number" ? tokens * priceOf(kind, tier) / 1e6 : undefined;
			const usage = asObject(selected.usage);
			const hasUsage = Object.keys(usage).length > 0;
			const usageHitRate = usage.steadyHitRate ?? usage.hitRate;
			const periodTier = pricing.period === "peak" ? "peak" : "off";
			const usageEstimate = typeof usage.hitRate === "number" && Number.isFinite(usage.hitRate) && typeof selected.tokensSaved === "number"
				&& typeof priceOf("hit", periodTier) === "number" && typeof priceOf("miss", periodTier) === "number"
				? selected.tokensSaved * (usage.hitRate * priceOf("hit", periodTier) + (1 - usage.hitRate) * priceOf("miss", periodTier)) / 1e6
				: undefined;
			const conversations = list(data.conversations).slice(0, 20);
			const hasConversationUsage = conversations.some((conversation) => { const itemUsage = asObject(asObject(conversation).usage); return typeof itemUsage.calls === "number" && itemUsage.calls > 0; });
			const byteRatio = ratioOf(selected.bytesBefore, selected.bytesAfter);
			const tokenRatio = ratioOf(selected.tokensBefore, selected.tokensAfter);
			const avgTokensPerRequest = typeof selected.assembleRequests === "number" && selected.assembleRequests > 0 && typeof selected.tokensSaved === "number"
				? selected.tokensSaved / selected.assembleRequests
				: undefined;
			const ledger = list(data.ledger).slice(-10);
			const statsPage = () => h("div", { className: "rg-stack" },
				h("div", { className: "rg-actions", "aria-label": "统计窗口" }, Object.entries(windowLabels).map(([key, label]) => h("button", { key, className: "rg-btn", type: "button", "aria-pressed": windowKey === key, disabled: busy, onClick: () => { if (key !== windowKey) setData((previous) => ({ ...previous, conversations: [] })); setWindowKey(key); } }, label))),
				!hasWindow && !statsLoading ? h("p", { className: "rg-muted" }, "当前宿主未提供窗口统计；不以进程累计值冒充所选窗口。") : null,
				h("div", { className: "rg-cards" },
					h(Card, { label: "瘦身率 · 所选窗口", value: formatPercent(byteRatio), note: `字节口径；token ${formatPercent(tokenRatio)}` }),
					h(Card, { label: "实测命中率", value: hasUsage ? formatPercent(usageHitRate) : "—", note: hasUsage ? `全量 ${formatPercent(usage.hitRate)} · 零命中 ${formatNumber(usage.zeroHitCalls)} 次` : "宿主未提供 usage" }),
					h(Card, { label: "字节减少", value: formatBytes(selected.bytesSaved), note: `省 ${formatPercent(byteRatio)}（${formatBytes(selected.bytesBefore)} → ${formatBytes(selected.bytesAfter)}）` }),
					h(Card, { label: "token 减少", value: formatNumber(selected.tokensSaved), note: `省 ${formatPercent(tokenRatio)}` }),
					h(Card, { label: "请求数", value: formatNumber(selected.assembleRequests), note: `实际处理 ${formatNumber(selected.assembleCalls)}` }),
					h(Card, { label: "涉及对话数", value: formatNumber(selected.sessions) }),
					h(Card, { label: "影子工具", value: formatNumber(selected.shadowed) }),
					h(Card, { label: "消隐工具", value: formatNumber(selected.hidden) })),
				h("section", null, h("h2", { className: "rg-section-title" }, "实测口径 · provider usage"),
					h("div", { className: "rg-rows" },
						h(Row, { label: "实测调用", value: typeof usage.calls === "number" ? `${formatNumber(usage.calls)} 次` : "—" }),
						h(Row, { label: "prompt token", value: typeof usage.promptTokens === "number" ? `${formatNumber(usage.promptTokens)}（命中 ${formatNumber(usage.hitTokens)} / 未命中 ${formatNumber(usage.missTokens)}）` : "—" }),
						h(Row, { label: "全量命中率 / 稳态命中率", value: `${formatPercent(usage.hitRate)} / ${formatPercent(usage.steadyHitRate)}` }),
						h(Row, { label: "零命中请求", value: typeof usage.zeroHitCalls === "number" ? `${formatNumber(usage.zeroHitCalls)} 次` : "—" }),
						h(Row, { label: "工具定义占比", value: usage.toolsShare === null || usage.toolsShare === undefined ? "—" : `${formatPercent(usage.toolsShare)}（仅统计配到 assemble 的请求）` }),
						h(Row, { label: "真账口径估价（元）", value: formatMoney(usageEstimate) })),
					h("p", { className: "rg-muted" }, "实测口径来自 provider usage；估价按实测命中结构折算，仍不是账单。")),
				h("section", null, h("h2", { className: "rg-section-title" }, "压缩效率"),
					h("div", { className: "rg-rows" },
						h(Row, { label: "窗口字节瘦身率", value: formatPercent(byteRatio) }),
						h(Row, { label: "窗口 token 瘦身率", value: formatPercent(tokenRatio) }),
						h(Row, { label: "每请求平均省 token", value: typeof avgTokensPerRequest === "number" ? `${formatNumber(Math.round(avgTokensPerRequest))} token` : "—" }),
						h(Row, { label: "累计瘦身率（本进程）", value: formatPercent(ratioOf(data.tokensBeforeTotal, data.tokensAfterTotal)) }),
						h(Row, { label: "工具命中率（本进程累计）", value: formatPercent(data.toolsSeen > 0 ? data.shadowedTotal / data.toolsSeen : undefined) }))),
				h("section", null, h("h2", { className: "rg-section-title" }, "省钱估算 · 所选窗口"),
					h("div", { className: "rg-rows" }, [["谷时 · 缓存命中", "off", "hit"], ["谷时 · 缓存未命中", "off", "miss"], ["峰时 · 缓存命中", "peak", "hit"], ["峰时 · 缓存未命中", "peak", "miss"]].map(([label, tier, kind]) => h(Row, { key: label, label, value: formatMoney(money(selected.tokensSaved, tier, kind)) }))),
					h("p", { className: "rg-muted" }, pricing.status === "priced" ? `价表：${formatText(pricing.label)} · ${formatText(pricing.asOf)}${pricing.override === true ? "（配置覆盖）" : ""}；仅预估，非账单。` : `未定价或价表缺失：${formatText(pricing.model)}；仅显示 token 口径。`)),
				h("section", null, h("h2", { className: "rg-section-title" }, windowKey === "today" ? "今天按对话" : `近 ${windowKey === "d7" ? 7 : 30} 天按对话`),
					h("div", { className: "rg-scroll", tabIndex: 0, "aria-label": "对话统计，可滚动" }, h("table", { className: "rg-table" },
						h("thead", null, h("tr", null, ["短 id", "首次活动", "最后活动", "请求数", "省 token", "瘦身率", ...(hasConversationUsage ? ["命中率"] : []), "省字节"].map((label) => h("th", { key: label, scope: "col" }, label)))),
						h("tbody", null, list(data.conversations).slice(0, 20).map((conversation, index) => {
							const item = asObject(conversation);
							const itemRatio = typeof item.bytesBefore === "number" && item.bytesBefore > 0 && typeof item.bytesSaved === "number"
								? item.bytesSaved / item.bytesBefore
								: undefined;
							return h("tr", { key: item.sessionId || index }, h("td", { title: item.sessionId }, item.short || String(item.sessionId || "—").slice(0, 8)), h("td", null, formatTime(item.firstAt, data.timezone)), h("td", null, formatTime(item.lastAt, data.timezone)), h("td", null, formatNumber(item.calls)), h("td", null, formatNumber(item.tokensSaved)), h("td", null, formatPercent(itemRatio)), hasConversationUsage ? h("td", null, formatPercent(asObject(item.usage).hitRate)) : null, h("td", null, formatBytes(item.bytesSaved)));
						})))), !list(data.conversations).length ? h("p", { className: "rg-muted" }, "暂无对话记录或宿主未提供；最多显示 20 条。") : null),
				h("details", { className: "rg-ledger" }, h("summary", { className: "rg-section-title" }, "本轮细节"),
					h("div", { className: "rg-rows" },
						h(Row, { label: "本次 token（前 → 后）", value: `${formatNumber(data.tokensBefore)} → ${formatNumber(data.tokensAfter)}` }),
						h(Row, { label: "本次 / 累计减少 token", value: `${formatNumber(data.tokensSaved)} / ${formatNumber(data.tokensSavedTotal)}` }),
						h(Row, { label: "本次 / 累计瘦身率", value: `${formatPercent(ratioOf(data.tokensBefore, data.tokensAfter))} / ${formatPercent(ratioOf(data.tokensBeforeTotal, data.tokensAfterTotal))}` }),
						h(Row, { label: "本次字节减少 / 消隐字节", value: `${formatBytes(data.bytesSaved)} / ${formatBytes(data.hiddenBytes)}` }),
						h(Row, { label: "瘦身试算（工具 / 字节）", value: `${formatNumber(data.wouldShadow)} / ${formatBytes(data.wouldSaveBytes)}` }),
						h(Row, { label: "消隐试算（工具 / 字节）", value: `${formatNumber(data.wouldHide)} / ${formatBytes(data.wouldHideBytes)}` }),
						[["看到工具（累计）", "toolsSeen"], ["因前缀跳过", "skippedByPrefix"], ["因 keepFull 跳过", "skippedByKeepFull"], ["因体积跳过", "skippedBySize"], ["压缩节点", "collapsedNodesLast"], ["保留 enum", "enumsKept"], ["保留 items", "itemsKept"], ["语义优先超预算（累计）", "oversizeSlimsTotal"], ["排序回退（累计）", "canonicalFallbacks"], ["失败", "failed"]].map(([label, key]) => h(Row, { key, label, value: formatNumber(data[key]) })),
						h(Row, { label: "最近错误", value: formatText(data.lastError) }))),
				h("details", { className: "rg-ledger" }, h("summary", { className: "rg-section-title" }, "最近决策"), ledger.length ? h("ul", { className: "rg-ledger-list" }, ledger.map((entry, index) => { const item = asObject(entry); return h("li", { key: index }, `${formatText(item.tool)} · ${formatText(item.action)} · ${formatText(item.reason)}`); })) : h("p", { className: "rg-muted" }, "暂无记录")),
				h("p", { className: "rg-muted" }, `每 5 秒刷新；token 按 4 字符估算、不是账单；按 ${data.timezone || "宿主未提供"} 时区切日；统计存档在 ${asObject(data.storage).dir || "宿主未提供"}。字节 ≠ token ≠ 钱；不可与其它插件数字相加。`));
			const configPage = () => h("div", { className: "rg-stack" },
				dirty ? h("p", { className: "rg-confirm" }, "精调尚有未保存改动，请先保存或放弃，再使用运行期开关。") : null,
				h("div", { className: "rg-rows" }, switchControl("truncation", "enabled", "MCP 工具截断", "关掉后不瘦身工具定义"), switchControl("truncation", "dryRun", "瘦身 dryRun", "只试算，不应用瘦身"), switchControl("ordering", "enabled", "确定性键排序", "只对对象键排序，不改工具列表顺序"), switchControl("visibility", "enabled", "工具消隐", "仅使用已配置的显式名单；keepFull 优先"), switchControl("visibility", "dryRun", "消隐 dryRun", "只试算，不移除工具投影")),
				h("h2", { className: "rg-section-title" }, "快捷预设 · 新会话生效"),
				h("div", { className: "rg-actions" }, preset("preset-cache", "缓存优先", false), preset("preset-traffic", "省流优先", true)),
				h("p", { className: "rg-muted" }, "preset 只切已有的截断与排序开关；不改 visibility 名单。"),
				h("p", { className: "rg-muted" }, `配置来源：${formatText(config.source || tuning.source)}。写入精调存档，重启后仍在；按会话冻结，新会话生效`));
			const tuningPage = () => {
				const groups = list(tuning.groups).map((group) => typeof group === "string" ? { id: group, label: group } : asObject(group));
				const groupKey = (group) => group.id || group.key || group.group || group.name;
				const known = new Set(groups.map(groupKey));
				validMetas.forEach((meta) => { const key = meta.group || "other"; if (!known.has(key)) { groups.push({ id: key, label: key === "other" ? "其它" : key }); known.add(key); } });
				return h("div", { className: "rg-stack" },
					h("p", { className: "rg-muted" }, `配置来源：${formatText(tuning.source)}；保存时间：${formatTime(tuning.savedAt, data.timezone)}；存档：${tuning.storePath || tuning.dir || "—"}`),
					list(tuning.warnings).length ? h("p", { className: "rg-confirm" }, tuning.warnings.map(display).join("；")) : null,
					dirty ? h("div", { className: "rg-actions" }, h("span", { className: "rg-muted" }, `${edits.length} 项改动${Object.keys(errors).length ? `，${Object.keys(errors).length} 项无效` : ""}`),
						h("button", { className: "rg-btn", type: "button", disabled: busy || !!Object.keys(errors).length, onClick: () => { clearPending(); const patch = {}; try { edits.forEach((entry) => setPath(patch, entry.path, entry.value)); void mutate(TUNING_PATH, { patch }); } catch (error) { setNotice(error.message); } } }, "保存"),
						h("button", { className: "rg-btn", type: "button", disabled: busy, onClick: discard }, "放弃改动")) : null,
					!validMetas.length ? h("p", { className: "rg-muted" }, "宿主尚未提供精调元数据，无法编辑。") : null,
					groups.map((group, index) => {
						const entries = validMetas.filter((meta) => (meta.group || "other") === groupKey(group));
						const advanced = (meta) => meta.risk === "high" || meta.kind === "object" || meta.kind === "stringList";
						if (!entries.length) return null;
						return h("section", { key: groupKey(group) || index }, h("h2", { className: "rg-section-title" }, group.label || group.title || groupKey(group)), group.summary ? h("p", { className: "rg-muted" }, group.summary) : null,
							h("div", { className: "rg-rows" }, entries.filter((meta) => !advanced(meta)).map(editField)),
							entries.some(advanced) ? h("details", { className: "rg-advanced" }, h("summary", null, `高级 / 危险项（${entries.filter(advanced).length}）`), h("div", { className: "rg-rows" }, entries.filter(advanced).map(editField))) : null);
					}),
					h("div", { className: "rg-actions" }, h("button", { className: `rg-btn${pending?.id === "defaults" ? " rg-pending" : ""}`, type: "button", disabled: busy || dirty || !validMetas.length, onClick: () => confirm("defaults", "restore", () => mutate(`${TUNING_PATH}/restore`, { kind: "defaults" })) }, pending?.id === "defaults" ? "再次点击恢复默认" : "恢复默认")),
					h("section", null, h("h2", { className: "rg-section-title" }, "备份"),
						h("div", { className: "rg-scroll", tabIndex: 0, "aria-label": "精调备份，可滚动" }, h("table", { className: "rg-table" },
							h("thead", null, h("tr", null, ["时间", "id", "来源", "操作"].map((label) => h("th", { key: label, scope: "col" }, label)))),
							h("tbody", null, list(tuning.backups).map((backup, index) => { const item = asObject(backup); const id = `backup:${item.id}`; return h("tr", { key: item.id || index }, h("td", null, formatTime(item.at, data.timezone)), h("td", { title: item.note || "" }, display(item.id)), h("td", null, display(item.source)), h("td", null, h("button", { className: `rg-btn${pending?.id === id ? " rg-pending" : ""}`, type: "button", disabled: busy || dirty || !item.id, onClick: () => confirm(id, "restore", () => mutate(`${TUNING_PATH}/restore`, { kind: "backup", id: item.id })) }, pending?.id === id ? "再次点击还原" : "还原"))); })))),
						!list(tuning.backups).length ? h("p", { className: "rg-muted" }, "暂无备份或宿主未提供。") : null),
					h("p", { className: "rg-muted" }, "恢复前请先保存或放弃改动；恢复也会备份当前配置。写入精调存档，重启后仍在；按会话冻结，新会话生效。"));
			};
			return h("div", { className: "rg-panel" },
				h("div", { className: "rg-head" }, h("div", null, h("h1", { className: "rg-title" }, "Rice Guard"), h("p", { className: "rg-sub" }, "工具投影：显式消隐、瘦身与确定性键排序")),
					h("button", { className: "rg-btn", type: "button", disabled: busy, onClick: () => { clearPending(); if (tab === "stats") void loadStats(); else if (tab === "config") { void loadStats(); void loadTuning(); } else void loadTuning(); } }, busy ? "请求中…" : "刷新")),
				h("div", { className: "rg-muted", role: "status" }, `存储：${storage.enabled === true ? "已落盘" : storage.enabled === false ? "未落盘，重启丢失" : "状态未知"} · ${dir || "目录未提供"}${storage.error ? `\n错误：${display(storage.error)}` : ""}`),
				storage.enabled === false ? h("div", { className: "rg-confirm", role: "alert" }, "未落盘，重启丢失") : null,
				h("div", { className: "rg-tabs", role: "tablist", "aria-label": "Rice Guard 页面" }, [["stats", "统计"], ["config", "配置"], ["tuning", "精调"]].map(([key, label]) => h("button", { key, id: `rg-tab-${key}`, className: "rg-btn", type: "button", role: "tab", "aria-selected": tab === key, "aria-controls": "rg-tabpanel", disabled: saving, onClick: () => { clearPending(); setTab(key); } }, `${label}${key === "tuning" && dirty ? " *" : ""}`))),
				statsError && tab !== "tuning" ? h("div", { className: "rg-error", role: "alert" }, `读不到统计：${statsError}`) : null,
				tuningError && tab !== "stats" ? h("div", { className: "rg-error", role: "alert" }, `读不到精调：${tuningError}；旧宿主可能尚未提供此接口。`) : null,
				pending ? h("div", { className: "rg-confirm", role: "status" }, "5 秒内再次点击同一按钮确认；点击其它操作或超时取消。配置按会话冻结，新会话生效。") : null,
				notice ? h("div", { className: "rg-notice", role: "status" }, notice) : null,
				h("div", { id: "rg-tabpanel", role: "tabpanel", "aria-labelledby": `rg-tab-${tab}`, className: "rg-stack" }, tab === "stats" ? statsPage() : tab === "config" ? configPage() : tuningPage()));
		}
		const zh = { panel: "Rice Guard", description: "工具投影消隐、瘦身与排序" };
		const en = zh;
		const inject = ["slots", "locale"];
		function apply(ctx) {
			injectStyles();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "rice-guard: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
				{ name: "sidebar.panellist", id: PANEL_ID, order: 50, label: () => t("panel"), locale: NS }, RiceGuardIcon));
			ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, RiceGuardPanel));
		}
		exports.PANEL_ID = PANEL_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
