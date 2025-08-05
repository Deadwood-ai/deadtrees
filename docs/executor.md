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
4. **IMMEDIATE TESTING REQUIREMENT:**
   - **If the task has a "Run Test" instruction, you MUST run the test immediately after implementing the feature.**
   - **If the task has a "VERIFY" step, you MUST run all verification tests and ensure they pass.**
   - **Use ONLY `deadtrees dev test` commands - NEVER run pytest directly.**
   - **STOP and ask for help if any test fails - do not proceed to the next task.**
5. When there are **no lint errors** and all tests pass:
   a. Mark the task as complete by changing `[ ]` to `[x]` in `implementation.md`.
   b. Summarize what changed, mentioning affected files and key logic.
6. **Reflect on learnings from this step:**
   - **ONLY** add to "Rules & Tips" if you discovered specific constraints, patterns, or gotchas that **future tasks in this same implementation.md** will need to know to succeed.
   - **DO NOT** add general documentation of what was done, generic best practices, or information already covered in requirements.md, design.md, or the implementation.md task descriptions.
   - Use this litmus test: _"Will a future task in this implementation plan fail or be done incorrectly without knowing this specific technical constraint or pattern?"_
   - Examples of what TO include: "Database enum updates require dropping dependent views first", "Status columns must follow is_*_done naming pattern", "Function X must be called before function Y"
   - Examples of what NOT to include: "Added logging", "Created new table", "Updated models", general coding standards, or anything that describes what you accomplished
   - Before adding, check if similar information already exists in "Rules & Tips" and merge/clarify instead of duplicating.
   - **Always** insert "Rules & Tips" section _immediately after the "Notes" section_ in implementation.md (never at the end).

7. STOP — do not proceed to the next task.

8. Never make changes outside the scope of the current task. Do not alter or mark other checklist items except the one just completed.

9. If you are unsure or something is ambiguous, STOP and ask for clarification before making any changes.

---

### Test-Driven Development Requirements

**CRITICAL:** This implementation follows a **test-driven, atomic approach**. Each feature must be tested immediately after implementation.

#### **Test Environment Setup**
Before starting any implementation:

1. **Environment Preparation:**
   ```bash
   source venv/bin/activate               # REQUIRED: Activate virtual environment first
   deadtrees dev start                    # Start development environment
   supabase db reset                      # Reset database (required before tests)
   make download-assets                   # Download test data if needed
   ```

2. **Test Data Setup (Task 0.1 requirement):**
   ```bash
   ./scripts/create_odm_test_data.sh      # Create ODM test ZIP files
   ls -la assets/test_data/raw_drone_images/test_*.zip  # Verify creation
   ```

#### **Testing Commands (Use EXCLUSIVELY)**

**NEVER run pytest directly - always use `deadtrees dev test` commands:**



```bash

# first activate the python env
source venv/bin/activate
# API tests
deadtrees dev test api api/tests/specific_test.py
deadtrees dev test api shared/tests/test_odm_models.py

# Processor tests  
deadtrees dev test processor processor/tests/test_process_odm.py
deadtrees dev test processor processor/tests/test_odm_pipeline.py

# Comprehensive tests (includes slow/marked tests)
deadtrees dev test api -m comprehensive
deadtrees dev test processor -m comprehensive

# Debug mode (for troubleshooting)
deadtrees dev debug api specific_test.py
deadtrees dev debug processor specific_test.py
```

#### **Testing Workflow for Each Task**

1. **Implement the feature** as described in the current task
2. **Run the specified test command immediately:**
   - Look for "**Run Test**:" instructions in the task
   - Execute exactly as specified: `deadtrees dev test [service] [path]`
3. **Verify tests pass:**
   - All tests must pass before marking task complete
   - Fix any test failures before proceeding
   - Add to "Rules & Tips" if you discover implementation constraints
4. **For VERIFY steps:** 
   - Run all listed verification commands
   - All verification tests must pass
   - STOP if any verification fails

#### **Test Failure Protocol**

If tests fail:
1. **DO NOT proceed to the next task**
2. **Analyze the failure** - check logs and error messages
3. **Fix the implementation** to make tests pass
4. **Re-run the tests** until they pass
5. **Ask for help** if stuck after reasonable debugging attempts
6. **Document any discovered constraints** in "Rules & Tips" if they affect future tasks

#### **Test Environment Management**

```bash
# Reset environment if issues arise
deadtrees dev stop
deadtrees dev start

# Check container logs if needed
docker-compose -f docker-compose.test.yaml logs api-test
docker-compose -f docker-compose.test.yaml logs processor-test

# Force rebuild after dependency changes
deadtrees dev start --force-rebuild
```

#### **Test Data Requirements**

- **Use real data:** Tests use actual drone images from `test_minimal_3_images.zip`, `test_small_10_images.zip`
- **No mocking:** Geospatial and utility functions tested with real coordinates and datasets
- **Test fixtures:** Follow existing patterns from `shared/testing/fixtures.py`
- **Cleanup:** Tests must clean up after themselves (database cascade deletes)

---

### Deadtrees Rules

