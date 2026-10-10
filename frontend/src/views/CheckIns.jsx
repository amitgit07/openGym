// Body check-in photos: a front, side and back photo per day, for a progress video later. Stored on
// the server as plain files named by date and pose (api/checkins.js), not in the synced state or the
// media system, so this view talks to the API directly and needs a signed-in profile.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUI } from '../store/useUI.js'
import { api, apiBlob, apiUpload } from '../lib/api.js'
import { fmtDate, todayISO } from '../lib/format.js'
import { Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { confirmSheet } from '../sheets.jsx'

const POSES = [{ key: 'front', label: 'Front' }, { key: 'side', label: 'Side' }, { key: 'back', label: 'Back' }]
const MAX_EDGE = 2048
const toast = m => useUI.getState().toast(m)

// Any photo the browser can show (an iPhone's HEIC included, which Safari decodes) becomes a JPEG
// at most MAX_EDGE on its long side: plenty for a 1080p video and well under the API's upload cap.
// Drawing through an <img> applies the EXIF rotation, so a portrait shot stays portrait.
export function toJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.naturalWidth * scale)
      canvas.height = Math.round(img.naturalHeight * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not read that photo'))), 'image/jpeg', 0.9)
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo')) }
    img.src = url
  })
}

function Thumb({ d, pose, ver }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let url = null, live = true
    apiBlob(`/api/checkins/${d}/${pose}`).then(b => { if (live) { url = URL.createObjectURL(b); setSrc(url) } }).catch(() => {})
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [d, pose, ver])
  return src
    ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    : <div style={{ width: '100%', height: '100%', background: 'var(--fill-3, rgba(127,127,127,.15))' }} />
}

const tile = { position: 'relative', display: 'block', width: '100%', aspectRatio: '3 / 4', borderRadius: 12, overflow: 'hidden', border: 0, padding: 0, cursor: 'pointer', background: 'var(--fill-3, rgba(127,127,127,.15))', color: 'inherit' }

export default function CheckIns() {
  const nav = useNavigate()
  const [date, setDate] = useState(todayISO())
  const [days, setDays] = useState(null)
  const [busy, setBusy] = useState(null)
  const [ver, setVer] = useState(0)
  const inputs = useRef({})

  const load = useCallback(() => api('/api/checkins').then(r => setDays(r.days || [])).catch(e => {
    setDays([])
    toast(e.status === 401 ? 'Sign in to keep check-in photos' : 'Could not load check-ins')
  }), [])
  useEffect(() => { load() }, [load])

  const today = days?.find(x => x.d === date)
  const has = pose => !!today?.poses.includes(pose)

  const onFile = async (pose, ev) => {
    const file = ev.target.files && ev.target.files[0]
    ev.target.value = ''
    if (!file) return
    setBusy(pose)
    try {
      const jpeg = await toJpeg(file)
      await apiUpload(`/api/checkins/${date}/${pose}`, jpeg, 'image/jpeg')
      setVer(v => v + 1)
      await load()
      toast(`${POSES.find(p => p.key === pose).label} photo saved`)
    } catch (e) {
      toast(e.message || 'Upload failed')
    } finally { setBusy(null) }
  }

  const remove = pose => confirmSheet({
    title: 'Delete photo?',
    message: `Deletes the ${pose} photo of ${fmtDate(date, true)}.`,
    confirmText: 'Delete', danger: true,
    onConfirm: async () => {
      try { await api(`/api/checkins/${date}/${pose}`, { method: 'DELETE' }); await load(); toast('Photo deleted') }
      catch (e) { toast(e.message || 'Could not delete') }
    },
  })

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/stats')} aria-label="Stats"><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 10 }}><h1>Body check-in</h1><div className="sub">Front, side and back, same spot each time</div></div>
    </div>

    <div className="card">
      <label className="measure-date">
        <span>Date</span>
        <input className="field" type="date" value={date} max={todayISO()} onChange={e => e.target.value && setDate(e.target.value)}
          style={{ display: 'block', boxSizing: 'border-box', minWidth: 0, maxWidth: '100%', WebkitAppearance: 'none', appearance: 'none', textAlign: 'start' }} />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {POSES.map(p => <div key={p.key} style={{ minWidth: 0 }}>
          <button type="button" style={tile} disabled={!!busy} onClick={() => inputs.current[p.key]?.click()} aria-label={`${p.label} photo`}>
            {has(p.key)
              ? <Thumb d={date} pose={p.key} ver={ver} />
              : <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <Icon name={busy === p.key ? 'image' : 'camera'} />
                  <span className="small muted">{busy === p.key ? 'Saving…' : 'Add'}</span>
                </div>}
          </button>
          <div className="row between" style={{ marginTop: 4, alignItems: 'center' }}>
            <span className="small">{p.label}</span>
            {has(p.key) && <button className="iconbtn" style={{ color: 'var(--red)' }} onClick={() => remove(p.key)} aria-label={`Delete ${p.label}`}><Icon name="trash" /></button>}
          </div>
          <input ref={el => { inputs.current[p.key] = el }} type="file" accept="image/*" hidden onChange={ev => onFile(p.key, ev)} />
        </div>)}
      </div>
      <div className="small dim" style={{ marginTop: 10 }}>Tap a slot to take or replace that photo. Same distance, light and pose every time makes the video smooth.</div>
    </div>

    <h4 className="sec" style={{ margin: '18px 2px 10px' }}>History</h4>
    {days === null ? <div className="empty small">Loading…</div>
      : !days.length ? <div className="empty small">No check-ins yet</div>
      : <div className="list">{days.map(day => <button type="button" key={day.d} className="card" onClick={() => setDate(day.d)}
          style={{ display: 'block', width: '100%', textAlign: 'start', color: 'inherit', outline: day.d === date ? '2px solid var(--accent, #4ade80)' : 'none' }}>
          <div className="row between" style={{ marginBottom: 8 }}><b>{fmtDate(day.d, true)}</b><span className="small dim">{day.poses.length}/3</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {POSES.map(p => <div key={p.key} style={{ ...tile, cursor: 'inherit' }}>{day.poses.includes(p.key) && <Thumb d={day.d} pose={p.key} ver={ver} />}</div>)}
          </div>
        </button>)}</div>}
  </div>
}
