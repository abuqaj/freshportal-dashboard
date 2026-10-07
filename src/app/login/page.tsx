"use client"

import { useState, useEffect, useRef, type CSSProperties } from "react"
import { signIn, useSession } from "next-auth/react"
import { useRouter } from "next/navigation"
import { ArrowRight, ArrowUp, Check, CircleAlert, Eye, EyeOff, Lock, User } from "lucide-react"
import { translations, Lang } from "@/lib/i18n"
import Wordmark, { LOGO_PATH } from "@/components/shell/Wordmark"
import { LanguageMenu } from "@/components/shell/TopBar"
import { Tip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { drawPath, loadAnime, loadMotion, motionLevel, shake, within } from "@/lib/motion"

// kokonutui's background-paths: two fans of thin curves across the page,
// one in emerald and one in brick, from the system palette.
function pathFan(side: 1 | -1) {
  return Array.from({ length: 18 }, (_, i) => {
    const a = i * 5 * side
    const b = i * 6
    return {
      d: `M-${380 - a} -${189 + b}C-${380 - a} -${189 + b} -${312 - a} ${216 - b} ${152 - a} ${343 - b}C${616 - a} ${470 - b} ${684 - a} ${875 - b} ${684 - a} ${875 - b}`,
      width: 0.5 + i * 0.04,
      opacity: 0.06 + i * 0.02,
    }
  })
}
const FANS = [{ cls: "lg-paths-a", paths: pathFan(1) }, { cls: "lg-paths-b", paths: pathFan(-1) }]

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const place = (i: number) => ({ "--i": i }) as CSSProperties

export default function LoginPage() {
  const { status } = useSession()
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState("")
  const [phase, setPhase] = useState<"idle" | "busy" | "ok">("idle")
  const [slow, setSlow] = useState(false)
  const [caps, setCaps] = useState(false)
  const [bad, setBad] = useState<"" | "user" | "password">("")
  const [trip, setTrip] = useState(false)
  const [exit, setExit] = useState(false)
  const [pathsOn, setPathsOn] = useState(false)
  const [lang, setLangState] = useState<Lang>("en")
  // Set while a sign-in is under way, so the session turning "authenticated"
  // does not swap the card for a spinner or jump ahead of the exit.
  const leaving = useRef(false)
  const card = useRef<HTMLFormElement>(null)
  const userInput = useRef<HTMLInputElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const paths = useRef<HTMLDivElement>(null)
  const trace = useRef<SVGPathElement>(null)
  const tick = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const saved = localStorage.getItem("fp_lang") as Lang | null
    if (saved && ["en", "nl", "pl", "es"].includes(saved)) setLangState(saved)
  }, [])

  useEffect(() => {
    if (status === "authenticated" && !leaving.current) router.replace("/")
  }, [status, router])

  // The page shows whole from the first paint. If anime.js arrives within a
  // second, the lines draw themselves in and a pen traces the logo once;
  // otherwise the lines just fade in.
  useEffect(() => {
    const level = motionLevel()
    if (level === "off") { setPathsOn(true); return }
    let gone = false
    within(loadAnime(), 1000).then(a => {
      if (gone) return
      setPathsOn(true)
      if (!a) return
      try {
        if (level === "full" && paths.current) {
          a.animate(a.svg.createDrawable([...paths.current.querySelectorAll("path")]), { draw: ["0 0", "0 1"], duration: 2000, delay: a.stagger(26), ease: "inOutQuad" })
        }
        const pen = trace.current
        if (pen) {
          pen.style.opacity = "1"
          a.animate(a.svg.createDrawable(pen), {
            draw: ["0 0", "0 1"], duration: level === "full" ? 1500 : 800, ease: "inOutSine",
            onComplete: () => { pen.style.opacity = "0" },
          })
        }
      } catch {}
    })
    void loadMotion()
    return () => { gone = true }
  }, [])

  function setLang(l: Lang) { setLangState(l); localStorage.setItem("fp_lang", l) }

  const tl = translations[lang].login

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (phase !== "idle") return
    if (!username.trim() || !password) {
      const missing = !username.trim() ? "user" : "password"
      setBad(missing)
      shake(card.current)
      ;(missing === "user" ? userInput : passwordInput).current?.focus()
      return
    }
    leaving.current = true
    setError("")
    setBad("")
    setPhase("busy")
    // A quick sign-in shows only the ring; the words come after a second.
    const slowTimer = setTimeout(() => setSlow(true), 1000)
    let refused = ""
    try {
      const result = await signIn("credentials", { username, password, redirect: false })
      if (result?.error) refused = tl.invalidCredentials
    } catch {
      refused = tl.loginFailed
    }
    clearTimeout(slowTimer)
    setSlow(false)
    if (refused) {
      leaving.current = false
      setPhase("idle")
      setError(refused)
      setBad("password")
      setPassword("")
      setTrip(true)
      setTimeout(() => setTrip(false), 520)
      shake(card.current)
      passwordInput.current?.focus()
      return
    }
    setPhase("ok")
    requestAnimationFrame(() => drawPath(tick.current?.querySelector("path")))
    const level = motionLevel()
    if (level !== "off") {
      await wait(260)
      setExit(true)
      await wait(level === "full" ? 560 : 300)
    }
    goToShell()
  }

  // Into the portal through a view transition: the logo flies into the top
  // bar. The transition holds the old picture until the shell says it is on
  // screen (page.tsx, "fp:shell-ready"), at most 1.5 s.
  function goToShell() {
    const doc = document as Document & { startViewTransition?: (update: () => Promise<void>) => unknown }
    if (!doc.startViewTransition || motionLevel() === "off") { router.replace("/"); return }
    try {
      doc.startViewTransition(() => new Promise<void>(resolve => {
        window.addEventListener("fp:shell-ready", () => resolve(), { once: true })
        setTimeout(resolve, 1500)
        router.replace("/")
      }))
    } catch {
      router.replace("/")
    }
  }

  if ((status === "loading" || status === "authenticated") && !leaving.current) {
    return (
      <div className="h-screen bg-ground flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-emerald border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="relative h-dvh overflow-y-auto overflow-x-hidden bg-ground">
      <div ref={paths} className={cn("lg-paths", pathsOn && "is-on")} aria-hidden="true">
        {FANS.map(fan => (
          <svg key={fan.cls} className={fan.cls} viewBox="0 0 696 316" preserveAspectRatio="xMidYMid slice" fill="none" stroke="currentColor">
            {fan.paths.map((p, i) => <path key={i} d={p.d} strokeWidth={p.width} strokeOpacity={p.opacity} />)}
          </svg>
        ))}
      </div>

      <div className="absolute right-3 top-3 z-10">
        <LanguageMenu t={translations[lang]} lang={lang} setLang={setLang} framed />
      </div>

      <div className="relative z-[1] mx-auto flex min-h-full w-full max-w-[412px] flex-col items-center justify-center gap-[18px] px-4 pb-7 pt-12">
        <div className="lg-rise flex flex-col items-center gap-3.5" style={place(0)}>
          <div className={cn("lg-mascot", phase === "busy" && "is-run", trip && "is-trip", exit && "is-exit")} aria-hidden="true">
            <span className="lg-mascot-shadow" />
            <span className="lg-mascot-ground" />
            <div className="lg-mascot-body">
              <img src="/mascot-runner.svg" alt="" width={435} height={348} className="block size-full select-none" draggable={false} />
              <span className="lg-mascot-hat">
                <img src="/fast-delivery-hat.svg" alt="" width={74} height={74} className="block size-full rotate-[40deg] select-none" draggable={false} />
              </span>
            </div>
          </div>
          <div className="relative w-[230px] text-ink">
            <Wordmark vtName="brand" className="block h-auto w-full" />
            <svg viewBox="0 0 233 22" className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden="true">
              <path ref={trace} d={LOGO_PATH} fill="none" stroke="var(--color-emerald)" strokeWidth={0.45} className="lg-trace" />
            </svg>
          </div>
        </div>

        <form ref={card} onSubmit={handleSubmit} noValidate style={place(1)}
          className="lg-rise w-full rounded-3xl border border-border bg-surface p-[22px] shadow-[0_10px_40px_-12px_rgba(17,26,20,0.16)]">
          <h1 className="mb-4 text-xl font-bold tracking-tight text-ink">{tl.signInBtn}</h1>

          <label className={cn("lg-field", bad === "user" && "is-bad")}>
            <User />
            <input
              ref={userInput}
              type="text"
              name="username"
              value={username}
              onChange={e => { setUsername(e.target.value); setBad(""); setError("") }}
              autoComplete="username"
              autoFocus
              required
              spellCheck={false}
              placeholder=" "
              readOnly={phase !== "idle"}
            />
            <span className="lg-label">{tl.usernameLabel}</span>
          </label>

          <div className="mt-2.5 flex items-center gap-2.5">
            <label className={cn("lg-field min-w-0 flex-1", bad === "password" && "is-bad")}>
              <Lock />
              <input
                ref={passwordInput}
                type={showPassword ? "text" : "password"}
                name="password"
                value={password}
                onChange={e => { setPassword(e.target.value); setBad(""); setError("") }}
                onKeyDown={e => setCaps(e.getModifierState("CapsLock"))}
                onKeyUp={e => setCaps(e.getModifierState("CapsLock"))}
                autoComplete="current-password"
                required
                placeholder=" "
                readOnly={phase !== "idle"}
              />
              <span className="lg-label">{tl.passwordLabel}</span>
              <Tip content={showPassword ? tl.hidePassword : tl.showPassword}>
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  tabIndex={-1}
                  aria-label={showPassword ? tl.hidePassword : tl.showPassword}
                  className="absolute right-1.5 top-1.5 grid size-9 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-muted hover:text-ink [&_svg]:size-[17px]"
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </button>
              </Tip>
            </label>

            <Tip content={tl.signInBtn}>
              <button
                type="submit"
                aria-label={tl.signInBtn}
                aria-busy={phase === "busy"}
                data-phase={phase}
                className="lg-go relative grid size-[50px] flex-none place-items-center rounded-full bg-emerald text-white shadow-[0_8px_18px_-8px_rgba(26,125,69,0.7)] transition-[background-color,scale] hover:bg-emerald-dark active:scale-90 data-[phase=ok]:bg-emerald-dark"
              >
                <span className="lg-go-st lg-go-idle"><ArrowRight className="size-5" /></span>
                <span className="lg-go-st lg-go-busy"><span className="size-5 animate-spin rounded-full border-2 border-white/35 border-t-white" /></span>
                <span className="lg-go-st lg-go-ok"><Check ref={tick} className="size-5" strokeWidth={2.6} /></span>
              </button>
            </Tip>
          </div>

          <div aria-live="polite" className="flex flex-wrap items-center gap-2 empty:hidden [&>*]:mt-3">
            {caps && (
              <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-sand px-2.5 text-xs font-semibold text-ink-2">
                <ArrowUp className="size-3.5" />
                {tl.capsLock}
              </span>
            )}
            {error && (
              <span role="alert" className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-brick">
                <CircleAlert className="size-[15px]" />
                {error}
              </span>
            )}
            {slow && <span className="shimmer-ink text-xs font-semibold">{tl.signingIn}</span>}
          </div>
        </form>

        <p className="lg-rise text-center text-[11px] text-ink-3" style={place(2)}>{tl.footer}</p>
      </div>
    </div>
  )
}
