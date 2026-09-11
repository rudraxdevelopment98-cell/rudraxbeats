// pages/pipeline.js — the pipeline as clickable nodes.
//
// One screen that answers the three questions the Settings list could not:
// what runs in what order, which model each stage uses, and whether that stage
// actually works right now. Every node carries its own keys, its own model
// picker, instructions for getting the credential, and a test that does the
// node's real job.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { motion, AnimatePresence } from 'framer-motion';
import { Background, Nav, Card, MotionButton, Loader, fadeUp, stagger } from '../components/ui';
import { NODES } from '../lib/pipelineSpec';

// Which readiness flag backs each node before it has been tested.
const READY_KEY = { lyrics: 'lyrics', song: 'song', cover: 'thumbnail', video: 'video', upload: 'upload' };

function StatusDot({ state }) {
  const title = {
    ok: 'Tested and working',
    fail: 'Test failed',
    ready: 'Configured, not tested yet',
    missing: 'Needs setup',
  }[state];
  return <span className={`dot ${state}`} title={title} />;
}

export default function Pipeline() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [fields, setFields] = useState(null);
  const [values, setValues] = useState({});
  const [readiness, setReadiness] = useState(null);
  const [selected, setSelected] = useState('lyrics');
  const [tests, setTests] = useState({});     // nodeId -> { loading } | result
  const [models, setModels] = useState({});   // target -> { loading, ok, message, models }
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [runningAll, setRunningAll] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/config');
    if (res.status === 401) return router.replace('/login');
    const data = await res.json();
    setFields(data.fields);
    setReadiness(data.readiness || null);
    setValues((prev) => {
      const next = { ...prev };
      for (const [k, f] of Object.entries(data.fields)) if (!f.secret) next[k] = f.value ?? '';
      return next;
    });
  }, [router]);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (!d.authed) return router.replace('/login');
        setUser(d.user || null);
        setReady(true);
        load();
      })
      .catch(() => router.replace('/login'));
  }, [router, load]);

  const node = useMemo(() => NODES.find((n) => n.id === selected) || NODES[0], [selected]);

  const stateOf = useCallback(
    (id) => {
      const t = tests[id];
      if (t && !t.loading) return t.ok ? 'ok' : 'fail';
      const key = READY_KEY[id];
      if (!key) return 'ready'; // storage is optional - never shown as missing
      return readiness?.[key] ? 'ready' : 'missing';
    },
    [tests, readiness]
  );

  const runTest = useCallback(async (n) => {
    setTests((t) => ({ ...t, [n.id]: { loading: true } }));
    try {
      const r = await fetch(`/api/test?target=${n.test}`);
      const data = await r.json();
      setTests((t) => ({ ...t, [n.id]: data }));
      return data;
    } catch (e) {
      const data = { ok: false, message: e.message };
      setTests((t) => ({ ...t, [n.id]: data }));
      return data;
    }
  }, []);

  const runAll = async () => {
    setRunningAll(true);
    // One at a time, in pipeline order, so a slow stage doesn't hide behind others.
    for (const n of NODES) await runTest(n);
    setRunningAll(false);
    load();
  };

  const loadModels = useCallback(async (target) => {
    setModels((m) => ({ ...m, [target]: { loading: true } }));
    try {
      const r = await fetch(`/api/models?target=${target}`);
      const data = await r.json();
      setModels((m) => ({ ...m, [target]: data }));
    } catch (e) {
      setModels((m) => ({ ...m, [target]: { ok: false, message: e.message, models: [] } }));
    }
  }, []);

  // Save an arbitrary patch and fold the fresh config back into state.
  const savePatch = async (patch) => {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Save failed');
    setFields(data.fields);
    setReadiness(data.readiness || null);
    return data;
  };

  const saveNode = async (n, keys) => {
    setSaving(true);
    try {
      const patch = {};
      for (const key of keys) if (values[key] !== undefined) patch[key] = values[key];
      const data = await savePatch(patch);
      // blank the secret inputs again so the masked hint shows
      setValues((prev) => {
        const next = { ...prev };
        for (const key of keys) if (data.fields[key]?.secret) next[key] = '';
        return next;
      });
      setSavedAt(Date.now());
    } catch (e) {
      setSavedAt(null);
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!ready || !fields) return <Loader />;

  // A stage can offer more than one provider (lyrics: free Gemini or paid
  // OpenAI); everything it shows then depends on which one is picked.
  const providerValue = node.providerField
    ? values[node.providerField] || fields[node.providerField]?.value || node.providerOptions[0].value
    : null;
  const option = node.providerOptions?.find((o) => o.value === providerValue) || null;
  const eff = {
    fields: option?.fields || node.fields,
    modelField: option?.modelField || node.modelField,
    modelsTarget: option?.modelsTarget || node.modelsTarget,
    howTo: option?.howTo || node.howTo,
  };

  // Switching provider is saved straight away, so the test below uses it.
  const pickProvider = async (value) => {
    setValues((v) => ({ ...v, [node.providerField]: value }));
    try { await savePatch({ [node.providerField]: value }); } catch (_) {}
    setTests((t) => ({ ...t, [node.id]: undefined }));
  };

  const modelList = eff.modelsTarget ? models[eff.modelsTarget] : null;
  const result = tests[node.id];

  return (
    <>
      <Background />
      <Nav user={user} />
      <div className="shell">
        <Card className="hero" delay={0.02}>
          <div className="eyebrow">PIPELINE</div>
          <h1>Every stage, one screen 🔍</h1>
          <p>
            Click a stage to pick its model, paste its key with instructions, and run a test that does
            that stage&apos;s real work — writes lyrics, paints a cover, asks YouTube which channel it owns.
          </p>
          <div className="hero-row">
            <MotionButton className="btn lg" onClick={runAll} disabled={runningAll}>
              {runningAll ? <><span className="spin" /> Testing…</> : <>▶ Test whole pipeline</>}
            </MotionButton>
          </div>
        </Card>

        {/* THE FLOW */}
        <Card delay={0.06}>
          <div className="card-title">Flow</div>
          <motion.div className="flow" variants={stagger} initial="hidden" animate="show">
            {NODES.map((n, i) => (
              <motion.div key={n.id} className="flow-item" variants={fadeUp}>
                <button
                  className={`flow-node ${selected === n.id ? 'sel' : ''} ${stateOf(n.id)}`}
                  onClick={() => setSelected(n.id)}
                >
                  <StatusDot state={stateOf(n.id)} />
                  <div className="ic">{n.icon}</div>
                  <div className="t">{n.title}</div>
                  <div className="p">{n.provider}</div>
                  {tests[n.id]?.loading && <span className="spin" style={{ marginTop: 6 }} />}
                </button>
                {i < NODES.length - 1 && <div className="flow-arrow">→</div>}
              </motion.div>
            ))}
          </motion.div>
        </Card>

        {/* THE SELECTED NODE */}
        <AnimatePresence mode="wait">
          <motion.div
            key={node.id}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
          >
            <Card>
              <div className="card-title" style={{ justifyContent: 'space-between' }}>
                <span>{node.icon} {node.title} — <span style={{ color: 'var(--muted)', fontWeight: 500 }}>{node.provider}</span></span>
                <MotionButton
                  className="btn ghost"
                  style={{ padding: '7px 14px', fontSize: 13 }}
                  onClick={() => runTest(node)}
                  disabled={result?.loading}
                >
                  {result?.loading ? <span className="spin" /> : '🧪 Test this stage'}
                </MotionButton>
              </div>

              <p className="node-does">{node.does}</p>

              {/* test result */}
              <AnimatePresence>
                {result && !result.loading && (
                  <motion.div
                    className={result.ok ? 'ok-note' : 'notice'}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    style={{ marginBottom: 16 }}
                  >
                    <div style={{ fontWeight: 600 }}>{result.ok ? '✓ ' : '✗ '}{result.message}</div>
                    {result.detail && <div className="hint" style={{ margin: '6px 0 0' }}>{result.detail}</div>}
                    {result.sample && <pre className="sample">{result.sample}</pre>}
                    {result.image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="sample-img" src={result.image} alt="Generated cover art" />
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
              {!result && <div className="hint" style={{ marginTop: 0 }}>Test does: {node.testDoes}</div>}

              {/* provider chooser */}
              {node.providerOptions && (
                <div className="field">
                  <label>Provider</label>
                  <div className="choices">
                    {node.providerOptions.map((o) => (
                      <button
                        key={o.value}
                        className={`choice ${providerValue === o.value ? 'sel' : ''}`}
                        onClick={() => pickProvider(o.value)}
                      >
                        <div className="t">{o.label}</div>
                        <div className="b">{o.blurb}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* model picker */}
              {eff.modelsTarget && (
                <div className="field">
                  <label>
                    Model
                    <span className="tag">{eff.modelsTarget === 'gemini' ? 'image' : 'text'}</span>
                  </label>
                  <div className="row" style={{ gap: 8 }}>
                    <select
                      className="input"
                      value={values[eff.modelField] ?? ''}
                      onChange={(e) => setValues({ ...values, [eff.modelField]: e.target.value })}
                    >
                      <option value="">
                        {String(eff.modelsTarget).startsWith('gemini')
                          ? 'Auto — pick one that works (recommended)'
                          : 'Default'}
                      </option>
                      {(modelList?.models || []).map((m) => (
                        <option key={m.id} value={m.id}>{m.id}{m.recommended ? '  ★ recommended' : ''}</option>
                      ))}
                      {/* keep a saved value visible even before the list is fetched */}
                      {values[eff.modelField] &&
                        !(modelList?.models || []).some((m) => m.id === values[eff.modelField]) && (
                          <option value={values[eff.modelField]}>{values[eff.modelField]}</option>
                        )}
                    </select>
                    <MotionButton
                      className="btn ghost"
                      style={{ padding: '10px 14px', fontSize: 13, whiteSpace: 'nowrap' }}
                      onClick={() => loadModels(eff.modelsTarget)}
                      disabled={modelList?.loading}
                    >
                      {modelList?.loading ? <span className="spin" /> : '↻ Load models'}
                    </MotionButton>
                  </div>
                  {modelList && !modelList.loading && (
                    <div className="hint" style={{ marginTop: 6, color: modelList.ok ? 'var(--muted)' : 'var(--amber)' }}>
                      {modelList.message}
                    </div>
                  )}
                </div>
              )}

              {/* the node's own settings */}
              {eff.fields.map((key) => {
                const f = fields[key];
                if (!f || key === eff.modelField) return null;
                return (
                  <div className="field" key={key}>
                    <label>
                      {f.label}
                      {f.secret && f.set ? <span className="tag ok">saved {f.hint}</span> : null}
                      {f.source === 'env' ? <span className="tag">from env</span> : null}
                    </label>
                    <input
                      className="input"
                      type={f.secret ? 'password' : 'text'}
                      value={f.secret ? values[key] || '' : values[key] ?? ''}
                      placeholder={f.secret ? (f.set ? 'leave blank to keep current' : 'not set') : ''}
                      onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                    />
                  </div>
                );
              })}

              <div className="row" style={{ gap: 10 }}>
                <MotionButton className="btn" onClick={() => saveNode(node, eff.fields)} disabled={saving}>
                  {saving ? <><span className="spin" /> Saving…</> : '💾 Save this stage'}
                </MotionButton>
                {node.connect && (
                  <a className="btn ghost" href={node.connect.href}>{node.connect.label}</a>
                )}
                <AnimatePresence>
                  {savedAt && (
                    <motion.span className="hint" style={{ margin: 0 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      Saved — run the test to confirm it works.
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>

              {/* how to get the credential */}
              {eff.howTo && (
                <details className="howto">
                  <summary>❓ {eff.howTo.title}</summary>
                  <ol>
                    {eff.howTo.steps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                  <a href={eff.howTo.link} target={eff.howTo.link.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
                    {eff.howTo.linkLabel} ↗
                  </a>
                  {eff.howTo.note && <div className="hint">{eff.howTo.note}</div>}
                </details>
              )}
            </Card>
          </motion.div>
        </AnimatePresence>
      </div>
    </>
  );
}
