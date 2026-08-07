import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Music2,
  Trash2,
  Upload,
  Play,
  Pause,
  Disc3,
  Search,
  Filter,
  Activity,
  Tag as TagIcon,
  ShieldCheck,
} from 'lucide-react';
import { apiService, BgmTrack } from '../services/api';
import { notify } from '../services/notifications';

interface BgmPageViewProps {
  onBackToPipeline: () => void;
}

const VIBE_CATEGORIES = [
  { key: 'all', label: '全部分类', desc: '包含全部 30+ 首确权音频' },
  { key: '治愈Lofi', label: '治愈Lofi (70-90BPM)', desc: '晨间护肤、舒缓氛围、雨声夜间' },
  { key: '轻快Pop', label: '轻快Pop (100-120BPM)', desc: '阳光活力、开箱分享、元气打卡' },
  { key: '卡点Electronic', label: '卡点Electronic (125-140BPM)', desc: '重低音Trap、左右脸对比、硬核拉丝' },
  { key: '品质Ambient', label: '品质Ambient (60-80BPM)', desc: '高级清透、沉浸水光、贵妇修护' },
  { key: '节奏R&B', label: '节奏R&B (90-110BPM)', desc: '都市精致、生活方式、夜间精养' },
  { key: 'ASMR纯音效', label: 'ASMR纯音效', desc: '水滴拉丝、按压泡泡、瓶身敲击' },
];

const BPM_RANGES = [
  { key: 'all', label: '全部 BPM' },
  { key: 'slow', label: '慢速 (<80 BPM)' },
  { key: 'mid', label: '中速 (80-110 BPM)' },
  { key: 'fast', label: '快速 (110-130 BPM)' },
  { key: 'hyper', label: '极速 (>130 BPM)' },
  { key: 'asmr', label: '纯音效 (0 BPM)' },
];

const POPULAR_TAGS = ['全部标签', '治愈Lofi', '轻快Pop', '卡点Electronic', '品质Ambient', '节奏R&B', 'ASMR纯音效', '硬核测评', '纯水声', '护肤日常', '左右脸对比'];

export const BgmPageView: React.FC<BgmPageViewProps> = ({ onBackToPipeline }) => {
  const [tracks, setTracks] = useState<BgmTrack[]>([]);
  // S0 三态：加载失败显式提示 + 重试，绝不静默空态
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);

  // Upload form
  const [name, setName] = useState('');
  const [artist, setArtist] = useState('');
  const [bpm, setBpm] = useState('90');
  const [mood, setMood] = useState('治愈Lofi');
  const [file, setFile] = useState<File | null>(null);
  const [licenseConfirmed, setLicenseConfirmed] = useState(false);

  // Filters & Search
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedBpmRange, setSelectedBpmRange] = useState<string>('all');
  const [selectedTag, setSelectedTag] = useState<string>('全部标签');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredTracks = (tracks || []).filter((t) => {
    if (!t) return false;

    const styleTags = Array.isArray(t.style_tags)
      ? t.style_tags
      : typeof t.style_tags === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(t.style_tags);
            return Array.isArray(parsed) ? parsed : [t.style_tags];
          } catch {
            return [t.style_tags];
          }
        })()
      : [];

    // 1. Category Filter
    if (selectedCategory !== 'all') {
      const matchCat =
        (t.mood && t.mood.includes(selectedCategory)) ||
        styleTags.some((tag) => tag.includes(selectedCategory));
      if (!matchCat) return false;
    }

    // 2. BPM Range Filter
    if (selectedBpmRange !== 'all') {
      const trackBpm = t.bpm || 0;
      if (selectedBpmRange === 'asmr' && trackBpm !== 0) return false;
      if (selectedBpmRange === 'slow' && (trackBpm === 0 || trackBpm >= 80)) return false;
      if (selectedBpmRange === 'mid' && (trackBpm < 80 || trackBpm > 110)) return false;
      if (selectedBpmRange === 'fast' && (trackBpm <= 110 || trackBpm > 130)) return false;
      if (selectedBpmRange === 'hyper' && trackBpm <= 130) return false;
    }

    // 3. Tag Filter
    if (selectedTag !== '全部标签') {
      const matchTag =
        (t.mood && t.mood.includes(selectedTag)) ||
        styleTags.some((tag) => tag.includes(selectedTag));
      if (!matchTag) return false;
    }

    // 4. Search Query
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      const trackName = (t.track_name || '').toLowerCase();
      const trackArtist = (t.artist || '').toLowerCase();
      const trackMood = (t.mood || '').toLowerCase();
      const matchesSearch =
        trackName.includes(query) ||
        trackArtist.includes(query) ||
        trackMood.includes(query) ||
        styleTags.some((tag) => tag.toLowerCase().includes(query));
      if (!matchesSearch) return false;
    }

    return true;
  });

  const loadTracks = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await apiService.bgm.fetchBgm();
      setTracks(list);
    } catch (err: any) {
      setLoadError(err?.message || '读取 BGM 库失败（后端不可用）');
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
    a.play().catch(() => notify('试听失败：音频地址不可用', 'error'));
    setAudioEl(a);
    setPlayingId(track.id);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除该 BGM？')) return;
    try {
      await apiService.bgm.deleteBgm(id);
      if (playingId === id) {
        audioEl?.pause();
        setPlayingId(null);
      }
      setTracks((prev) => prev.filter((track) => track.id !== id));
      notify('BGM 已删除', 'success');
    } catch (error: any) {
      notify(error?.message || 'BGM 删除失败', 'error');
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      notify('请选择有明确授权依据的音频文件', 'error');
      return;
    }
    if (!licenseConfirmed) {
      notify('请先确认已取得商业使用授权', 'error');
      return;
    }
    setUploading(true);
    try {
      const res = await apiService.bgm.uploadBgm({
        file: file || undefined,
        name: name || file?.name || '未命名曲目',
        artist: artist || '自定义商家确权',
        bpm: Number(bpm) || 90,
        mood: mood || '治愈Lofi',
        styleTags: [mood || '通用', '已商用'],
        licenseConfirmed,
      });
      if (res.success && res.data) {
        setTracks((prev) => [res.data!, ...prev]);
        setName('');
        setArtist('');
        setFile(null);
        setBpm('90');
        setMood('治愈Lofi');
        setLicenseConfirmed(false);
        notify('✅ BGM 已标准化入库！', 'success');
      } else {
        notify(res.error || '上传失败', 'error');
      }
    } catch (err: any) {
      notify(err?.message || '上传失败', 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
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
              <h1 className="text-lg font-bold text-slate-900">确权 BGM 曲库 (30+ 6大调性标准化)</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200/60 text-[11px] font-semibold flex items-center gap-1">
                <ShieldCheck className="w-3 h-3 text-violet-600" />
                100% COMMERCIAL AUTHORIZED
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Step 4 仅从本库语义匹配推荐曲目。按 6 大标准化调性分类、BPM 范围段与情绪标签精确筛选。
            </p>
          </div>
        </div>
        <div className="text-xs text-slate-500 font-semibold bg-slate-50 border border-slate-200 px-3.5 py-2 rounded-xl">
          已标准化收录 <span className="text-violet-600 font-bold text-sm">{tracks.length}</span> 首音轨
        </div>
      </div>

      {/* Upload Box */}
      <form
        onSubmit={handleUpload}
        className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-2xs grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3"
      >
        <div className="md:col-span-2 lg:col-span-4 flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-violet-600" />
            <span className="text-sm font-bold text-slate-800">上传确权 BGM 音轨</span>
          </div>
          <span className="text-[11px] text-slate-400">支持 MP3/WAV 格式，自动标记授权说明</span>
        </div>
        <input
          type="text"
          placeholder="曲名 (例: Sunshine Glow Pop)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-xs focus:outline-none focus:border-violet-500"
        />
        <input
          type="text"
          placeholder="艺人 / 厂牌 (例: Chillout Lab)"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-xs focus:outline-none focus:border-violet-500"
        />
        <input
          type="number"
          placeholder="BPM (例: 128)"
          value={bpm}
          onChange={(e) => setBpm(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-xs focus:outline-none focus:border-violet-500"
        />
        <select
          value={mood}
          onChange={(e) => setMood(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-xs focus:outline-none focus:border-violet-500 bg-white"
        >
          <option value="治愈Lofi">治愈Lofi (70-90BPM)</option>
          <option value="轻快Pop">轻快Pop (100-120BPM)</option>
          <option value="卡点Electronic">卡点Electronic (125-140BPM)</option>
          <option value="品质Ambient">品质Ambient (60-80BPM)</option>
          <option value="节奏R&B">节奏R&B (90-110BPM)</option>
          <option value="ASMR纯音效">ASMR纯音效</option>
        </select>
        <input
          type="file"
          accept="audio/*"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="md:col-span-2 lg:col-span-3 px-3 py-1.5 rounded-xl border border-slate-200 text-xs file:mr-2 file:text-xs file:px-2 file:py-1 file:rounded-lg file:border-0 file:bg-violet-50 file:text-violet-700"
        />
        <label className="md:col-span-2 lg:col-span-3 flex items-start gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={licenseConfirmed}
            onChange={(event) => setLicenseConfirmed(event.target.checked)}
            className="mt-0.5"
          />
          <span>我确认已取得该音频的商业使用授权，并可提供授权依据。</span>
        </label>
        <button
          type="submit"
          disabled={uploading}
          className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold disabled:opacity-50 transition-all cursor-pointer shadow-2xs"
        >
          {uploading ? '标准化上传中…' : '上传并入库'}
        </button>
      </form>

      {/* 6 大调性标准化分类 Selector */}
      <div className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-2xs space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-violet-600" />
            <span className="text-xs font-bold text-slate-800">6 大标准化调性分类筛选</span>
          </div>
          <span className="text-[11px] text-slate-400">
            显示 {filteredTracks.length} / {tracks.length} 首音轨
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {VIBE_CATEGORIES.map((cat) => {
            const isSelected = selectedCategory === cat.key;
            return (
              <button
                key={cat.key}
                onClick={() => setSelectedCategory(cat.key)}
                className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                  isSelected
                    ? 'bg-violet-600 text-white border-violet-600 shadow-2xs'
                    : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200/80'
                }`}
              >
                <div className="text-xs font-bold truncate">{cat.label}</div>
                <div className={`text-[10px] mt-1 line-clamp-1 ${isSelected ? 'text-violet-100' : 'text-slate-400'}`}>
                  {cat.desc}
                </div>
              </button>
            );
          })}
        </div>

        {/* Multi-Dimensional Filters Bar */}
        <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
          {/* BPM Filter */}
          <div className="flex items-center gap-1.5 overflow-x-auto">
            <Activity className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span className="text-xs font-semibold text-slate-500 shrink-0">BPM 段:</span>
            {BPM_RANGES.map((b) => (
              <button
                key={b.key}
                onClick={() => setSelectedBpmRange(b.key)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium shrink-0 transition-all cursor-pointer ${
                  selectedBpmRange === b.key
                    ? 'bg-violet-100 text-violet-700 font-bold border border-violet-200'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>

          {/* Search Bar */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="搜索曲名 / 艺人 / 标签..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 text-xs bg-slate-50 focus:bg-white focus:border-violet-500 focus:outline-none w-56 transition-all"
            />
          </div>
        </div>

        {/* Quick Tag Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto pt-1">
          <TagIcon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span className="text-xs font-semibold text-slate-500 shrink-0">标签:</span>
          {POPULAR_TAGS.map((t) => (
            <button
              key={t}
              onClick={() => setSelectedTag(t)}
              className={`px-2.5 py-1 rounded-md text-[11px] shrink-0 transition-all cursor-pointer ${
                selectedTag === t
                  ? 'bg-slate-900 text-white font-bold'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Track List Display */}
      <div className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-2xs">
        {loadError ? (
          <div className="text-center py-12">
            <div className="mx-auto w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mb-3">
              <Activity className="w-6 h-6 text-red-400" />
            </div>
            <p className="text-sm font-semibold text-red-600">BGM 库加载失败</p>
            <p className="text-xs text-slate-500 mt-1">{loadError}</p>
            <button
              onClick={() => void loadTracks()}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold px-3.5 py-1.5 transition-colors cursor-pointer"
            >
              <Activity className="w-3.5 h-3.5" /> 重试加载
            </button>
          </div>
        ) : loading ? (
          <p className="text-sm text-slate-400 text-center py-10">加载标准化 BGM 曲库…</p>
        ) : filteredTracks.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <Disc3 className="w-10 h-10 mx-auto mb-3 opacity-40 text-violet-500" />
            <p className="text-sm font-semibold text-slate-600">未找到符合当前筛选条件的 BGM 音轨</p>
            <p className="text-xs text-slate-400 mt-1">请重置筛选条件或上传新音频</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {filteredTracks.map((t) => {
              const styleTags = Array.isArray(t.style_tags)
                ? t.style_tags
                : typeof t.style_tags === 'string'
                ? (() => {
                    try {
                      const p = JSON.parse(t.style_tags);
                      return Array.isArray(p) ? p : [t.style_tags];
                    } catch {
                      return [t.style_tags];
                    }
                  })()
                : [];
              return (
                <div
                  key={t.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50/80 border border-slate-200/80 hover:border-violet-300 hover:bg-violet-50/20 transition-all"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="p-2.5 rounded-xl bg-violet-50 text-violet-600 border border-violet-100 shrink-0 mt-0.5">
                      <Music2 className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-slate-900 truncate">{t.track_name}</p>
                        <span className="px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 text-[10px] font-bold shrink-0">
                          {t.mood || '标准化调性'}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
                        <span>艺人: <strong className="text-slate-700">{t.artist}</strong></span>
                        <span>·</span>
                        <span>BPM: <strong className="text-violet-700">{t.bpm === 0 ? '0 (ASMR纯音效)' : t.bpm}</strong></span>
                        <span>·</span>
                        <span className="text-emerald-600 font-medium">✓ {t.license_type || '已商业授权'}</span>
                      </p>
                      {styleTags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {styleTags.map((tag) => (
                            <span
                              key={tag}
                              className="px-2 py-0.5 rounded-md text-[10px] bg-white border border-slate-200 text-slate-600 font-medium"
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                    <button
                      type="button"
                      onClick={() => handlePlay(t)}
                      disabled={!t.audio_url}
                      className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                        playingId === t.id
                          ? 'bg-violet-600 text-white shadow-2xs'
                          : 'bg-white border border-slate-200 hover:border-violet-300 text-slate-700'
                      }`}
                    >
                      {playingId === t.id ? (
                        <>
                          <Pause className="w-3.5 h-3.5" /> 暂停试听
                        </>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5" /> 播放试听
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(t.id)}
                      className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 transition-colors cursor-pointer"
                      title="删除"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
