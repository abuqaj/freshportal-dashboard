import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { SignJWT } from "jose"
import { getUserByUsername, verifyPassword } from "./auth-db"

const secret = new TextEncoder().encode(process.env.AUTH_SECRET ?? "dev-secret-change-me")

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const username = credentials?.username as string | undefined
        const password = credentials?.password as string | undefined
        if (!username || !password) return null

        const user = await getUserByUsername(username)
        if (!user || !user.is_active) return null

        const valid = await verifyPassword(password, user.password_hash)
        if (!valid) return null

        // Generate backend JWT for FastAPI verification
        const backendToken = await new SignJWT({
          sub: String(user.id),
          username: user.username,
          permissions: user.permissions,
        })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt()
          .setExpirationTime("8h")
          .sign(secret)

        return {
          id: String(user.id),
          name: user.username,
          email: null,
          backendToken,
          permissions: user.permissions,
        }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.backendToken = (user as { backendToken?: string }).backendToken
        token.permissions = (user as { permissions?: string[] }).permissions
      }
      return token
    },
    session({ session, token }) {
      session.user.backendToken = (token.backendToken as string) ?? ""
      session.user.permissions = (token.permissions as string[]) ?? []
      return session
    },
  },
  pages: {
    signIn: "/login",
  },
  session: { strategy: "jwt" },
})
