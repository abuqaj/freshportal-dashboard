import { DefaultSession } from "next-auth"

declare module "next-auth" {
  interface Session {
    user: {
      backendToken: string
      permissions: string[]
    } & DefaultSession["user"]
  }

  interface User {
    backendToken?: string
    permissions?: string[]
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    backendToken?: string
    permissions?: string[]
  }
}
