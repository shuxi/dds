"""Top-level buildscripts package.

On Python 2.7, `unittest` resolves dotted names by importing the parent module and then
`getattr()`-walking the remaining components. Ensure the `tests` package is importable as an
attribute.
"""

from . import tests  # noqa: F401
