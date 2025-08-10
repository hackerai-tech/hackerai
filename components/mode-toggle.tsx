"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

export function ModeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  // useEffect only runs on the client, so now we can safely show the UI
  React.useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return null
  }

  const handleToggle = () => {
    if (theme === "light") {
      setTheme("dark")
    } else {
      setTheme("light")
    }
  }

  const getButtonStyles = () => {
    switch (theme) {
      case "light":
        return "bg-yellow-100 text-yellow-600 border-yellow-200 hover:bg-yellow-200"
      case "dark":
        return "bg-slate-800 text-slate-200 border-slate-600 hover:bg-slate-700"
      default:
        return "bg-yellow-100 text-yellow-600 border-yellow-200 hover:bg-yellow-200"
    }
  }

  const renderIcon = () => {
    switch (theme) {
      case "light":
        return <Sun className="h-5 w-5" />
      case "dark":
        return <Moon className="h-5 w-5" />
      default:
        return <Sun className="h-5 w-5" />
    }
  }

  return (
    <button
      onClick={handleToggle}
      className={`inline-flex items-center justify-center rounded-md border p-2 transition-all duration-200 ${getButtonStyles()}`}
      aria-label="Toggle theme"
    >
      {renderIcon()}
    </button>
  )
}