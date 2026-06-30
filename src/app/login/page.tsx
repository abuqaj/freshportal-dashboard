"use client"

import { useState, useEffect } from "react"
import { signIn, useSession } from "next-auth/react"
import { useRouter } from "next/navigation"
import { translations, Lang } from "@/lib/i18n"

function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      {[0, 72, 144, 216, 288].map((deg, i) => (
        <ellipse key={i} cx="14" cy="14" rx="3.5" ry="7.5"
          fill="#1A7D45" opacity={i === 0 ? 1 : 0.7}
          transform={`rotate(${deg} 14 14) translate(0 -5.5)`} />
      ))}
      <circle cx="14" cy="14" r="3.2" fill="#EC4328" />
    </svg>
  )
}

export default function LoginPage() {
  const { status } = useSession()
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
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
          <div className="w-16 h-16 rounded-3xl bg-surface border border-border shadow-sm flex items-center justify-center mb-4">
            <LogoMark size={36} />
          </div>
          <h1 className="text-2xl font-bold text-ink tracking-tight">FreshPortal</h1>
          <p className="text-sm text-ink-3 mt-1">{tl.subtitle}</p>
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
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                placeholder="••••••••"
                className="w-full h-10 px-3 rounded-xl border border-border bg-ground text-sm text-ink placeholder-ink-3/50
                           focus:outline-none focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 transition-all"
              />
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
