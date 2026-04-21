"""Test package for buildscripts.

On Python 2.7, `unittest` resolves dotted names by importing the parent module and then
`getattr()`-walking the remaining components. Ensure subpackages are importable as attributes.
"""

from . import resmokelib  # noqa: F401
