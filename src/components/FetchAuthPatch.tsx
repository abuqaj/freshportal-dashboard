"use client"

import { useSession } from "next-auth/react"
import { useEffect, useRef } from "react"

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? ""

/**
 * Patches window.fetch to append Authorization: Bearer <backendToken>
 * to all requests targeting the Railway API. Mounted once in the root layout.
 */
export default function FetchAuthPatch() {
  const { data: session } = useSession()
  const tokenRef = useRef<string>("")

  // Keep the ref always current — avoids re-running the effect on token change
  tokenRef.current = session?.user?.backendToken ?? ""

  useEffect(() => {
    if (!RAILWAY) return

    const orig = window.fetch.bind(window)

    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString()

      if (url.startsWith(RAILWAY) && tokenRef.current) {
        const headers = new Headers(init?.headers)
        if (!headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${tokenRef.current}`)
        }
        return orig(input, { ...init, headers })
      }
      return orig(input, init)
    }

    return () => {
      window.fetch = orig
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
