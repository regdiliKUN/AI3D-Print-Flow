/**
 * Terminal reporter for a job's update stream (used by the CLI).
 *
 * `publicJob.logs` is always the *tail* of the job log, so every update repeats
 * the lines that were already printed. A cursor index cannot be used because
 * the window slides once it is full, so previously emitted line keys are
 * remembered instead. The key set is rebuilt from the current window when it
 * grows too large, which keeps memory bounded without re-printing.
 */
export function logKey(entry) {
  return `${entry?.t || ''}|${entry?.stream || ''}|${entry?.text || ''}`;
}

export function createJobReporter({ write = (line) => console.log(line) } = {}) {
  let seen = new Set();
  let lastProgress = -1;
  let lastMessage = '';
  return (publicJob) => {
    const logs = publicJob.logs || [];
    for (const entry of logs) {
      const key = logKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      write(`  ${entry.text}`);
    }
    if (seen.size > 1200) {
      seen = new Set(logs.map(logKey));
    }
    const progress = Math.round(publicJob.progress || 0);
    const message = publicJob.message || '';
    if (progress !== lastProgress || (message && message !== lastMessage)) {
      lastProgress = progress;
      lastMessage = message;
      write(`[${progress}%] ${message}`);
    }
  };
}
