import { createContext, createElement, useContext } from 'react'

export const PageStateUserContext = createContext(null)

export function PageStateUserProvider({ userId, children }) {
  return createElement(PageStateUserContext.Provider, { value: userId || null }, children)
}

export function usePageStateUserId() {
  return useContext(PageStateUserContext)
}
