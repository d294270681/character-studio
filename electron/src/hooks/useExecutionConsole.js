import { useCallback, useEffect, useRef, useState } from 'react';
import { jobEntries, mergeEntries } from '../lib/execution-log.js';

export default function useExecutionConsole(serverState, systemLog) {
  const [entries, setEntries] = useState([]);
  const seen = useRef(new Set());
  const append = useCallback(incoming => {
    const fresh = incoming.filter(entry => entry?.id && !seen.current.has(entry.id));
    fresh.forEach(entry => seen.current.add(entry.id));
    if (seen.current.size > 10000) seen.current = new Set([...seen.current].slice(-5000));
    if (fresh.length) setEntries(previous => mergeEntries(previous, fresh));
  }, []);
  useEffect(() => {
    let live = true;
    const unsubscribe = window.studio?.onConsole?.(packet => {
      if (packet.type === 'entry') append([packet.entry]);
      if (packet.type === 'reset') setEntries([]);
    });
    window.studio?.consoleState?.().then(items => { if (live) append(items); }).catch(() => {});
    return () => { live = false; unsubscribe?.(); };
  }, [append]);
  useEffect(() => {
    const projectPath = serverState?.project?.path;
    append((serverState?.jobs || []).filter(job => job.project_path === projectPath).slice(0, 12).flatMap(jobEntries));
  }, [serverState, append]);
  useEffect(() => {
    append(systemLog.map(entry => ({ ...entry, source: 'system', message: entry.text,
      level: entry.kind || 'info' })));
  }, [systemLog, append]);
  const clear = useCallback(async () => {
    await window.studio?.consoleClear?.();
    setEntries([]);
  }, []);
  return { entries, clear };
}
