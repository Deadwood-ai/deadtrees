## EXECUTOR MODE — ONE TASK AT A TIME

### Instructions

1. **Read the "Rules & Tips" section in `implementation.md` (if it exists) before starting.**
   - Ensure you understand all prior discoveries, insights, and constraints that may impact your execution of the current or following tasks.
2. Open `implementation.md` and find the first unchecked (`[ ]`) task.
3. Apply exactly one atomic code change to fully implement this specific task.
   - **Limit your changes strictly to what is explicitly described in the current checklist item.**
   - Do not combine, merge, or anticipate future steps.
   - **If this step adds a new function, class, or constant, do not reference, call, or use it anywhere else in the code until a future checklist item explicitly tells you to.**
   - Only update files required for this specific step.
   - **Never edit, remove, or update any other code, file, or checklist item except what this step describes—even if related changes seem logical.**
4. **Check for TypeScript/Linting errors:**
   - Ensure no TypeScript compilation errors
   - Fix any linting issues that arise from your changes
   - Verify imports are correct and types are properly defined
5. When there are **no compilation or lint errors**:
   a. Mark the task as complete by changing `[ ]` to `[x]` in `implementation.md`.
   b. Summarize what changed, mentioning affected files and key logic.
6. **Reflect on learnings from this step:**

   - **ONLY** add to "Rules & Tips" if you discovered specific constraints, patterns, or gotchas that **future tasks in this same implementation.md** will need to know to succeed.
   - **DO NOT** add general documentation of what was done, generic best practices, or information already covered in requirements.md, design.md, or the implementation.md task descriptions.
   - Use this litmus test: _"Will a future task in this implementation plan fail or be done incorrectly without knowing this specific technical constraint or pattern?"_
   - Examples of what TO include: "Enum imports must use specific import syntax", "Interface updates require updating all components that use them", "File validation must happen before upload state changes"
   - Examples of what NOT to include: "Added new component", "Updated types", "Created utility function", general coding standards, or anything that describes what you accomplished
   - Before adding, check if similar information already exists in "Rules & Tips" and merge/clarify instead of duplicating.
   - **Always** insert "Rules & Tips" section _immediately after the "Notes" section_ in implementation.md (never at the end).

7. STOP — do not proceed to the next task.

8. Never make changes outside the scope of the current task. Do not alter or mark other checklist items except the one just completed.

9. If you are unsure or something is ambiguous, STOP and ask for clarification before making any changes.

---

### Frontend Development Workflow

#### **File Organization Patterns**

- **Types**: Add to existing files in `src/types/` or create new ones as needed
- **Utilities**: Place in `src/utils/` with descriptive names
- **Components**: Organize by feature in `src/components/`
- **Hooks**: Custom hooks go in `src/hooks/`
- **API functions**: Add to `src/api/` directory

#### **TypeScript & React Patterns**

- **Interface Updates**: When updating interfaces, check all usages across the codebase
- **Enum Additions**: Add to existing enum files in `src/types/`
- **Component Props**: Use proper TypeScript interfaces for component props
- **File Extensions**: Use `.tsx` for React components, `.ts` for utilities
- **Import Paths**: Use relative imports within the same feature, absolute for cross-feature

#### **Error Handling Protocol**

If TypeScript or build errors occur:

1. **DO NOT proceed to the next task**
2. **Fix compilation errors** - TypeScript must compile cleanly
3. **Address linting issues** - Use `npm run lint:fix` for auto-fixable issues
4. **Verify imports** - Ensure all imports resolve correctly
5. **Check component usage** - When updating types, verify all usages still work
6. **Ask for help** if stuck after reasonable debugging attempts
7. **Document any discovered constraints** in "Rules & Tips" if they affect future tasks

#### **Development Server Management**

```bash
# Start fresh development environment
npm run dev

# If issues arise, restart the dev server
# Ctrl+C to stop, then npm run dev again

# Clear node_modules if dependency issues
rm -rf node_modules package-lock.json
npm install
npm run dev
```

#### **Code Quality Requirements**

- **TypeScript**: All code must compile without errors
- **Linting**: Follow existing ESLint configuration
- **Imports**: Organize imports (types, libraries, then relative imports)
- **Components**: Follow existing component patterns in the codebase
- **Styling**: Use existing Tailwind CSS and Ant Design patterns

---

### React Frontend Rules

- **Component Structure**: Follow existing patterns in `src/components/`
- **State Management**: Use React Query for server state, React Context for global state
- **Styling**: Tailwind CSS + Ant Design component library
- **File Naming**: PascalCase for components, camelCase for utilities
- **Type Safety**: All props, state, and API responses should be properly typed
