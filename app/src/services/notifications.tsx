import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

type NotificationTone = 'success' | 'error' | 'info';
type NotificationItem = {
  id: number;
  message: string;
  tone: NotificationTone;
};

const listeners = new Set<(item: NotificationItem) => void>();
let sequence = 0;

export function notify(message: unknown, tone?: NotificationTone) {
  const text = String(message || '操作已完成');
  const inferredTone =
    tone ||
    (/失败|错误|无法|异常|请先|尚无/.test(text)
      ? 'error'
      : /成功|完成|已保存|✅/.test(text)
        ? 'success'
        : 'info');
  const item = { id: ++sequence, message: text, tone: inferredTone };
  listeners.forEach((listener) => listener(item));
}

export function NotificationViewport() {
  const [items, setItems] = useState<NotificationItem[]>([]);

  useEffect(() => {
    const listener = (item: NotificationItem) => {
      setItems((current) => [...current.slice(-3), item]);
      window.setTimeout(() => {
        setItems((current) => current.filter((entry) => entry.id !== item.id));
      }, item.tone === 'error' ? 7000 : 4500);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <div
      className="fixed right-4 top-4 z-[100] w-[min(24rem,calc(100vw-2rem))] space-y-2"
      aria-live="polite"
      aria-atomic="false"
    >
      {items.map((item) => {
        const Icon =
          item.tone === 'success' ? CheckCircle2 : item.tone === 'error' ? AlertCircle : Info;
        const colors =
          item.tone === 'success'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : item.tone === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-900'
              : 'border-sky-200 bg-sky-50 text-sky-900';
        return (
          <div
            key={item.id}
            role={item.tone === 'error' ? 'alert' : 'status'}
            className={`rounded-2xl border p-3 shadow-lg flex items-start gap-2.5 ${colors}`}
          >
            <Icon className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-sm font-semibold leading-5 flex-1 whitespace-pre-line">
              {item.message}
            </p>
            <button
              type="button"
              onClick={() =>
                setItems((current) => current.filter((entry) => entry.id !== item.id))
              }
              className="p-1 rounded-lg hover:bg-black/5"
              aria-label="关闭通知"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
