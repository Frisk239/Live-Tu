import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, User, KeyRound, ArrowRight, AlertCircle } from 'lucide-react';

interface LoginScreenProps {
  onLoginSuccess: (username: string) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('haini');
  const [password, setPassword] = useState('888');
  const [errorMsg, setErrorMsg] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setIsLoading(true);

    setTimeout(() => {
      if (username.trim() === 'haini' && password === '888') {
        onLoginSuccess(username.trim());
      } else {
        setErrorMsg('账号或密码错误！默认测试账号：haini / 密码：888');
        setIsLoading(false);
      }
    }, 400);
  };

  const handleQuickFill = () => {
    setUsername('haini');
    setPassword('888');
    setErrorMsg('');
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 p-4 select-none">
      <motion.div
        initial={{ opacity: 0, y: 15, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="w-full max-w-md bg-white border border-slate-200/90 rounded-2xl p-8 shadow-xl relative overflow-hidden"
      >
        {/* Top Accent Bar */}
        <div className="absolute top-0 inset-x-0 h-1 bg-blue-600" />

        {/* Brand Header */}
        <div className="flex flex-col items-center text-center mb-8 pt-2">
          <div className="relative flex items-center justify-center w-12 h-12 rounded-xl bg-blue-600 text-white font-bold shadow-md shadow-blue-600/20 mb-3">
            <span className="text-lg tracking-tight">BUV</span>
            <div className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-white rounded-full" />
          </div>

          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50 border border-blue-200/60 text-blue-700 text-xs font-medium mb-3">
            <Sparkles className="w-3.5 h-3.5 text-blue-600" />
            <span>AI 短视频反推与生成工作台</span>
          </div>

          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            欢迎登录平台
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            短视频解析 · 镜头运镜 · 爆款文案 · BGM卡点 · 成品合成
          </p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleLogin} className="space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-slate-700 block mb-1.5 flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-slate-400" />
              <span>账号 (Username)</span>
            </label>
            <div className="relative">
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入测试账号 (haini)"
                className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-slate-200/90 text-slate-900 text-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all shadow-2xs"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700 block mb-1.5 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-slate-400" />
              <span>密码 (Password)</span>
            </label>
            <div className="relative">
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入登录密码 (888)"
                className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-slate-200/90 text-slate-900 text-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all shadow-2xs"
              />
            </div>
          </div>

          {/* Quick Credential Hint Button */}
          <div className="flex items-center justify-between text-xs pt-1">
            <span className="text-slate-500">
              测试凭据: <strong className="text-slate-800 font-semibold">haini / 888</strong>
            </span>
            <button
              type="button"
              onClick={handleQuickFill}
              className="text-blue-600 hover:text-blue-700 font-medium hover:underline cursor-pointer"
            >
              一键填入凭据
            </button>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full mt-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm shadow-md shadow-blue-600/20 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {isLoading ? (
              <>
                <Sparkles className="w-4 h-4 animate-spin text-white" />
                <span>验证登录中...</span>
              </>
            ) : (
              <>
                <span>立即登录工作台</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Footer Info */}
        <div className="mt-8 pt-4 border-t border-slate-100 text-center text-[11px] text-slate-400">
          BUV AI Studio · 企业级短视频反推与AIGC全流水线平台
        </div>
      </motion.div>
    </div>
  );
};
