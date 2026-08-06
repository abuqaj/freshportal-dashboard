import { auth } from "@/lib/auth"
import { NextResponse } from "next/server"

export default auth((req) => {
  const { pathname } = req.nextUrl

  // Always allow auth routes and login page
  if (
    pathname.startsWith("/api/auth") ||
    pathname === "/login" ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/logo.svg" ||
    pathname === "/iconffs.png" ||
    pathname.startsWith("/icons/")
  ) {
    return NextResponse.next()
  }

  // Require authentication for everything else
  if (!req.auth) {
    const loginUrl = new URL("/login", req.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
})

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
