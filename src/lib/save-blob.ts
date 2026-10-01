/** Saves a fetched file under its own name. The API wants the token header,
 *  so a plain link cannot fetch it; a blob: link can, and once the download
 *  has started it no longer needs the link. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
