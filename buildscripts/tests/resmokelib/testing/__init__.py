"""Test package for resmokelib testing.

On Python 2.7, `unittest` resolves dotted names by importing the parent module and then
`getattr()`-walking the remaining components. Ensure subpackages are importable as attributes.
"""

from . import hooks  # noqa: F401
