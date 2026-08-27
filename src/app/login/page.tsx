"use client"

import { useState, useEffect } from "react"
import { signIn, useSession } from "next-auth/react"
import { useRouter } from "next/navigation"
import { translations, Lang } from "@/lib/i18n"

export default function LoginPage() {
  const { status } = useSession()
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [lang, setLangState] = useState<Lang>("en")

  useEffect(() => {
    const saved = localStorage.getItem("fp_lang") as Lang | null
    if (saved && ["en", "nl", "pl", "es"].includes(saved)) setLangState(saved)
  }, [])

  useEffect(() => {
    if (status === "authenticated") router.replace("/")
  }, [status, router])

  const tl = translations[lang].login

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const result = await signIn("credentials", {
        username,
        password,
        redirect: false,
      })
      if (result?.error) {
        setError(tl.invalidCredentials)
      } else {
        router.replace("/")
      }
    } catch {
      setError(tl.loginFailed)
    } finally {
      setLoading(false)
    }
  }

  if (status === "loading" || status === "authenticated") {
    return (
      <div className="h-screen bg-ground flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-emerald border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="h-screen bg-ground flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <img src="/iconffs.png" alt="Fresh From Source" className="h-auto w-auto mb-4" />
          <p className="text-sm text-ink-3">{tl.subtitle}</p>
        </div>

        {/* Card */}
        <div className="bg-surface rounded-3xl border border-border shadow-[0_8px_40px_-8px_rgba(0,0,0,0.14)] p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1.5">{tl.usernameLabel}</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
                placeholder="your-username"
                className="w-full h-10 px-3 rounded-xl border border-border bg-ground text-sm text-ink placeholder-ink-3/50
                           focus:outline-none focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 transition-all"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1.5">{tl.passwordLabel}</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  placeholder="••••••••"
                  className="w-full h-10 pl-3 pr-10 rounded-xl border border-border bg-ground text-sm text-ink placeholder-ink-3/50
                             focus:outline-none focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  tabIndex={-1}
                  aria-label={showPassword ? tl.hidePassword : tl.showPassword}
                  className="absolute right-0 top-0 h-10 w-10 flex items-center justify-center text-ink-3 hover:text-ink transition-colors"
                >
                  {showPassword ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4.5 h-4.5">
                      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.8 21.8 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4.5 h-4.5">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-xs text-ember font-medium px-1">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 rounded-xl bg-emerald text-white text-sm font-semibold
                         hover:bg-emerald/90 active:scale-[0.98] transition-all
                         disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-2"
            >
              {loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  {tl.signingIn}
                </>
              ) : tl.signInBtn}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-ink-3/50 mt-6">
          {tl.footer}
        </p>
      </div>
    </div>
  )
}
