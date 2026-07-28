import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Music2,
  Trash2,
  Upload,
  Play,
  Pause,
  Disc3,
} from 'lucide-react';
import { apiService, BgmTrack } from '../services/api';

interface BgmPageViewProps {
  onBackToPipeline: () => void;
}

export const BgmPageView: React.FC<BgmPageViewProps> = ({ onBackToPipeline }) => {
  const [tracks, setTracks] = useState<BgmTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);

  // Upload form
  const [name, setName] = useState('');
  const [artist, setArtist] = useState('');
  const [bpm, setBpm] = useState('90');
  const [mood, setMood] = useState('治愈');
  const [file, setFile] = useState<File | null>(null);

  const loadTracks = async () => {
    setLoading(true);
    try {
      const list = await apiService.bgm.fetchBgm();
      setTracks(list);
    } catch {
      setTracks([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTracks();
    return () => {
      audioEl?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePlay = (track: BgmTrack) => {
    if (!track.audio_url) return;
    if (playingId === track.id && audioEl) {
      audioEl.pause();
      setPlayingId(null);
      return;
    }
    audioEl?.pause();
    const a = new Audio(track.audio_url);
    a.onended = () => setPlayingId(null);
    a.play().catch(() => alert('试听失败：音频地址不可用'));
    setAudioEl(a);
    setPlayingId(track.id);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除该 BGM？')) return;
    await apiService.bgm.deleteBgm(id);
    if (playingId === id) {
      audioEl?.pause();
      setPlayingId(null);
    }
    setTracks((prev) => prev.filter((t) => t.id !== id));
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file && !name) {
      alert('请选择音频文件或至少填写曲名');
      return;
    }
    setUploading(true);
    try {
      const res = await apiService.bgm.uploadBgm({
        file: file || undefined,
        name: name || file?.name || '未命名曲目',
        artist: artist || '自定义',
        bpm: Number(bpm) || 90,
        mood: mood || '治愈',
        styleTags: [mood || '通用'],
      });
      if (res.success && res.data) {
        setTracks((prev) => [res.data!, ...prev]);
        setName('');
        setArtist('');
        setFile(null);
        setBpm('90');
        setMood('治愈');
        alert('✅ BGM 已入库');
      } else {
        alert(res.error || '上传失败');
      }
    } catch (err: any) {
      alert(err?.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button
            onClick={onBackToPipeline}
            className="p-2.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-200/80 shadow-2xs transition-all flex items-center gap-1.5 text-xs font-semibold shrink-0 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4 text-slate-500" />
            <span>返回流水线</span>
          </button>
          <div className="p-3 rounded-xl bg-violet-50 text-violet-600 border border-violet-200/60 shrink-0">
            <Music2 className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900">确权 BGM 曲库</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200/60 text-[11px] font-semibold">
                BGM LIBRARY
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Step 4 仅从本库语义匹配推荐曲目。请维护已商业授权音频。
            </p>
          </div>
        </div>
        <div className="text-xs text-slate-500 font-semibold">
          共 <span className="text-violet-600 font-bold text-sm">{tracks.length}</span> 首
        </div>
      </div>

      {/* Upload */}
      <form
        onSubmit={handleUpload}
        className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-2xs grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"
      >
        <div className="md:col-span-2 lg:col-span-3 flex items-center gap-2 mb-1">
          <Upload className="w-4 h-4 text-violet-600" />
          <span className="text-sm font-bold text-slate-800">上传新曲目</span>
        </div>
        <input
          type="text"
          placeholder="曲名"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-xs"
        />
        <input
          type="text"
          placeholder="艺人"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-xs"
        />
        <input
          type="number"
          placeholder="BPM"
          value={bpm}
          onChange={(e) => setBpm(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-xs"
        />
        <select
          value={mood}
          onChange={(e) => setMood(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-xs"
        >
          <option value="治愈">治愈</option>
          <option value="卡点">卡点</option>
          <option value="高级">高级</option>
          <option value="反差">反差</option>
          <option value="硬核测评">硬核测评</option>
        </select>
        <input
          type="file"
          accept="audio/*"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-xs file:mr-2 file:text-xs"
        />
        <button
          type="submit"
          disabled={uploading}
          className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold disabled:opacity-50"
        >
          {uploading ? '上传中…' : '入库'}
        </button>
      </form>

      {/* List */}
      <div className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-2xs">
        {loading ? (
          <p className="text-sm text-slate-400 text-center py-10">加载曲库…</p>
        ) : tracks.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <Disc3 className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">曲库为空，请上传确权 BGM</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tracks.map((t) => (
              <div
                key={t.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 hover:border-violet-200 transition-all"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div className="p-2 rounded-lg bg-violet-50 text-violet-600 border border-violet-100 shrink-0">
                    <Music2 className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 truncate">{t.track_name}</p>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {t.artist} · BPM {t.bpm} · {t.mood} · {t.license_type}
                    </p>
                    {Array.isArray(t.style_tags) && t.style_tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {t.style_tags.map((tag) => (
                          <span
                            key={tag}
                            className="px-1.5 py-0.5 rounded text-[10px] bg-white border border-slate-200 text-slate-500"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handlePlay(t)}
                    disabled={!t.audio_url}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-200 hover:border-violet-300 text-slate-700 disabled:opacity-40"
                  >
                    {playingId === t.id ? (
                      <>
                        <Pause className="w-3.5 h-3.5" /> 暂停
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5" /> 试听
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(t.id)}
                    className="p-2 rounded-lg text-rose-500 hover:bg-rose-50 border border-transparent hover:border-rose-200"
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
