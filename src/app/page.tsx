"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { upload } from "@vercel/blob/client";
import { createSHA256 } from "hash-wasm";
import styles from "./page.module.css";
import type { Meeting } from "@/lib/types";
import { STATUS_LABELS } from "@/lib/config";

type ApiError = { error?: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json()) as T & ApiError;
  if (!response.ok) throw new Error(body.error || "Ошибка запроса.");
  return body;
}

async function fileSha256(file: File): Promise<string> {
  const hasher = await createSHA256();
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    hasher.update(new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer()));
  }
  return hasher.digest();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function sourceLabel(meeting: Meeting) {
  return meeting.source_type === "upload" ? "Ручная загрузка" : "Яндекс Диск";
}

export default function Home() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [mode, setMode] = useState<"upload" | "link">("upload");
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMeetings = useCallback(async () => {
    try {
      const result = await api<{ meetings: Meeting[] }>("/api/meetings");
      setMeetings(result.meetings);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить встречи.");
    }
  }, []);

  const loadMeeting = useCallback(async (id: string) => {
    try {
      const result = await api<{ meeting: Meeting; canonicalId: string }>(`/api/meetings/${id}`);
      setSelected(result.meeting);
      if (result.canonicalId !== id) setSelectedId(result.canonicalId);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить встречу.");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadMeetings(), 0);
    const timer = window.setInterval(() => void loadMeetings(), 3000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadMeetings]);

  useEffect(() => {
    if (!selectedId) return;
    const initial = window.setTimeout(() => void loadMeeting(selectedId), 0);
    const timer = window.setInterval(() => void loadMeeting(selectedId), 2500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadMeeting, selectedId]);

  const activeCount = useMemo(
    () => meetings.filter((meeting) => ["receiving", "transcribing", "analyzing"].includes(meeting.status)).length,
    [meetings],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      let result: { meeting: Meeting; duplicate: boolean };
      if (mode === "upload") {
        if (!file) throw new Error("Выберите файл MP4 или WebM.");
        if (!["video/mp4", "video/webm"].includes(file.type)) throw new Error("Поддерживаются только MP4 и WebM.");
        const contentHash = await fileSha256(file);
        const blob = await upload(file.name, file, {
          access: "private",
          handleUploadUrl: "/api/blob/upload",
        });
        result = await api("/api/meetings", {
          method: "POST",
          body: JSON.stringify({
            sourceType: "upload",
            title: title.trim() || file.name.replace(/\.(mp4|webm)$/i, ""),
            blobUrl: blob.url,
            blobPathname: blob.pathname,
            filename: file.name,
            mimeType: file.type,
            size: file.size,
            contentHash,
          }),
        });
      } else {
        if (!sourceUrl.trim()) throw new Error("Вставьте публичную ссылку Яндекс Диска.");
        result = await api("/api/meetings", {
          method: "POST",
          body: JSON.stringify({ sourceType: "yandex_disk", title: title.trim() || undefined, sourceUrl: sourceUrl.trim() }),
        });
      }

      setSelectedId(result.meeting.id);
      setSelected(result.meeting);
      setNotice(
        result.duplicate
          ? "Эта запись уже обрабатывалась. Открыт существующий результат."
          : result.meeting.previous_meeting_id
            ? "Файл по этой ссылке изменился. Создан новый связанный анализ."
            : "Встреча принята в обработку.",
      );
      setTitle("");
      setSourceUrl("");
      setFile(null);
      await loadMeetings();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось создать анализ.");
    } finally {
      setSubmitting(false);
    }
  }

  async function retry() {
    if (!selected) return;
    setError(null);
    try {
      const result = await api<{ meeting: Meeting }>(`/api/meetings/${selected.id}/retry`, { method: "POST", body: "{}" });
      setSelected(result.meeting);
      setNotice("Повторная обработка запущена.");
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Не удалось повторить обработку.");
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>MULTIMODAL AI WORKSPACE</span>
          <h1>Разбор встреч</h1>
          <p>Видео превращается в расшифровку, решения и задачи — в одном потоке.</p>
        </div>
        <div className={styles.headerStat}>
          <strong>{meetings.length}</strong><span>встреч сохранено</span>
          {activeCount > 0 && <small>{activeCount} сейчас в работе</small>}
        </div>
      </header>

      {(notice || error) && <div className={`${styles.banner} ${error ? styles.bannerError : styles.bannerSuccess}`}>{error || notice}</div>}

      <section className={styles.workspace}>
        <aside className={styles.sidebar}>
          <form className={styles.createCard} onSubmit={submit}>
            <div className={styles.tabs} role="tablist" aria-label="Источник записи">
              <button type="button" className={mode === "upload" ? styles.activeTab : ""} onClick={() => setMode("upload")}>Файл</button>
              <button type="button" className={mode === "link" ? styles.activeTab : ""} onClick={() => setMode("link")}>Яндекс Диск</button>
            </div>
            <label>Название<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Планирование продукта" maxLength={200} /></label>
            {mode === "upload" ? (
              <label className={styles.fileDrop}>
                <input type="file" accept="video/mp4,video/webm,.mp4,.webm" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                <span>{file ? file.name : "Выберите MP4 или WebM"}</span>
                <small>{file ? `${(file.size / 1024 / 1024).toFixed(1)} МБ` : "Файл загружается напрямую в Blob"}</small>
              </label>
            ) : (
              <label>Публичная ссылка<input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://disk.yandex.ru/d/…" /></label>
            )}
            <button className={styles.primaryButton} disabled={submitting}>{submitting ? "Получение файла…" : "Начать анализ"}</button>
          </form>

          <div className={styles.meetingList}>
            <div className={styles.listHeading}><h2>История</h2><span>{meetings.length}</span></div>
            {meetings.length === 0 ? <p className={styles.empty}>Здесь появятся обработанные встречи.</p> : meetings.map((meeting) => (
              <button key={meeting.id} className={`${styles.meetingRow} ${selectedId === meeting.id ? styles.selectedRow : ""}`} onClick={() => setSelectedId(meeting.id)}>
                <span className={`${styles.statusDot} ${styles[`status_${meeting.status}`]}`} />
                <span className={styles.meetingCopy}><strong>{meeting.title}</strong><small>{sourceLabel(meeting)} · {formatDate(meeting.updated_at)}</small></span>
                <span className={styles.rowStatus}>{STATUS_LABELS[meeting.status]}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className={styles.detailPanel}>
          {!selected ? <div className={styles.heroEmpty}><span>✦</span><h2>Выберите встречу</h2><p>Или загрузите новую запись, чтобы увидеть этапы обработки и результат.</p></div> : <MeetingDetails meeting={selected} onRetry={retry} />}
        </section>
      </section>
    </main>
  );
}

function MeetingDetails({ meeting, onRetry }: { meeting: Meeting; onRetry: () => void }) {
  const analysis = meeting.analysis;
  const processing = ["receiving", "transcribing", "analyzing"].includes(meeting.status);
  return (
    <article className={styles.details}>
      <header className={styles.detailHeader}>
        <div><span className={styles.sourceBadge}>{sourceLabel(meeting)}</span><h2>{meeting.title}</h2><p>Обновлено {formatDate(meeting.updated_at)}</p></div>
        <span className={`${styles.statusPill} ${styles[`status_${meeting.status}`]}`}>{STATUS_LABELS[meeting.status]}</span>
      </header>
      {processing && <div className={styles.processingCard}><span className={styles.spinner} aria-hidden="true" /><div><strong>{STATUS_LABELS[meeting.status]}</strong><p>Страница обновится автоматически. Проценты не рассчитываются.</p></div></div>}
      {meeting.status === "error" && <div className={styles.errorCard}><div><strong>Обработка не завершена</strong><p>{meeting.error_message || "Повторите попытку."}</p></div><button className={styles.retryButton} onClick={onRetry}>Повторить</button></div>}
      {meeting.previous_meeting_id && <p className={styles.versionNote}>Это новая версия файла по ранее использованной ссылке.</p>}
      {meeting.status === "ready" && analysis && (
        <div className={styles.resultGrid}>
          <section className={`${styles.resultCard} ${styles.summaryCard}`}><span>КРАТКО</span><h3>Резюме</h3><p>{analysis.summary}</p></section>
          <ListCard title="Темы" items={analysis.topics} /><ListCard title="Решения" items={analysis.decisions} /><ListCard title="Открытые вопросы" items={analysis.open_questions} />
          <section className={`${styles.resultCard} ${styles.wideCard}`}><span>ДЕЙСТВИЯ</span><h3>Задачи</h3>{analysis.tasks.length ? <div className={styles.taskList}>{analysis.tasks.map((task, index) => <div key={`${task.task}-${index}`}><strong>{task.task}</strong><small>{task.assignee || "Исполнитель не указан"}{task.deadline ? ` · ${task.deadline}` : ""}</small></div>)}</div> : <p>Задачи не зафиксированы.</p>}</section>
          <section className={`${styles.resultCard} ${styles.wideCard}`}><details><summary>Полная расшифровка</summary><pre>{meeting.transcript}</pre></details></section>
        </div>
      )}
    </article>
  );
}

function ListCard({ title, items }: { title: string; items: string[] }) {
  return <section className={styles.resultCard}><h3>{title}</h3>{items.length ? <ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <p>Не зафиксировано.</p>}</section>;
}
