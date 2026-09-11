Building MongoDB
================

To build MongoDB, you will need:

* A modern C++ compiler. One of the following is required.
    * GCC 5.4.0 or newer
    * Clang 3.8 (or Apple XCode 8.3.2 Clang) or newer
    * Visual Studio 2015 Update 3 or newer (See Windows section below for details)
* On Linux and macOS, the libcurl library and header is required. MacOS includes libcurl.
    * Fedora/RHEL - dnf install libcurl-devel
    * Ubuntu/Debian - apt-get install libcurl-dev
* Python 3.6+ (3.12 tested) and Pip modules:
  * pyyaml

MongoDB supports the following architectures: arm64, ppc64le, s390x, and x86-64.
More detailed platform instructions can be found below.


MongoDB Tools
--------------

The MongoDB command line tools (mongodump, mongorestore, mongoimport, mongoexport, etc)
have been rewritten in [Go](http://golang.org/) and are no longer included in this repository.

The source for the tools is now available at [mongodb/mongo-tools](https://github.com/mongodb/mongo-tools).

Python Prerequisites
---------------

In order to build MongoDB, Python 3.6+ is required, and several Python modules. Recommended:

    $ python3 -m venv .venv-py3
    $ .venv-py3/bin/pip install -r buildscripts/requirements.txt
    $ .venv-py3/bin/python buildscripts/scons.py MONGO_VERSION=4.0.3 mongod --disable-warnings-as-errors

At minimum you need `pyyaml`, `cheetah3`, and `setuptools` (for some SCons tools).
On Debian/Ubuntu you can also install `python3-yaml` from apt.

SCons
---------------

For detail information about building, please see [the build manual](https://github.com/mongodb/mongo/wiki/Build-Mongodb-From-Source)

This tree vendors SCons 3.1.2 under `src/third_party/scons-3.1.2/` and launches it via
`buildscripts/scons.py`.

If you want to build everything (mongod, mongo, tests, etc):

    $ python3 buildscripts/scons.py MONGO_VERSION=4.0.3 all --disable-warnings-as-errors

If you only want to build the database:

    $ python3 buildscripts/scons.py MONGO_VERSION=4.0.3 mongod --disable-warnings-as-errors

To install

    $ python3 buildscripts/scons.py --prefix=/opt/mongo install

Please note that prebuilt binaries are available on [mongodb.org](http://www.mongodb.org/downloads) and may be the easiest way to get started.

SCons Targets
--------------

* mongod
* mongos
* mongo
* core (includes mongod, mongos, mongo)
* all

Windows
--------------

See [the windows build manual](https://github.com/mongodb/mongo/wiki/Build-Mongodb-From-Source#windows-specific-instructions)

Build requirements:
* Visual Studio 2015 Update 2 or newer
* Python 2.7, ActiveState ActivePython 2.7.x Community Edition for Windows is recommended

If using VS 2015 Update 3, two hotfixes are required to build. For details, see:
* https://support.microsoft.com/en-us/help/3207317/visual-c-optimizer-fixes-for-visual-studio-2015-update-3
* https://support.microsoft.com/en-za/help/4020481/fix-link-exe-crashes-with-a-fatal-lnk1000-error-when-you-use-wholearch

Or download a prebuilt binary for Windows at www.mongodb.org.

Debian/Ubuntu
--------------

To install dependencies on Debian or Ubuntu systems:

    # aptitude install build-essential
    # aptitude install libboost-filesystem-dev libboost-program-options-dev libboost-system-dev libboost-thread-dev

To run tests as well, you will need PyMongo (and requests). Prefer the project Python 3 venv:

    $ .venv-py3/bin/pip install 'pymongo>=3.0,<4' 'requests>=2.16.1'
    $ .venv-py3/bin/python buildscripts/resmoke.py --suites=core

(System package `python-pymongo` targets Python 2 and is not used by the Python 3 path.)

OS X
--------------

Using [Homebrew](http://brew.sh):

    $ brew install mongodb

Using [MacPorts](http://www.macports.org):

    $ sudo port install mongodb

FreeBSD
--------------

Install the following ports:

  * devel/libexecinfo
  * lang/clang38
  * lang/python

Optional Components if you want to use system libraries instead of the libraries included with MongoDB

  * archivers/snappy
  * lang/v8
  * devel/boost
  * devel/pcre

Add `CC=clang38 CXX=clang++38` to the `scons` options, when building.

OpenBSD
--------------
Install the following ports:

  * devel/libexecinfo
  * lang/gcc
  * lang/python

Special Build Notes
--------------
  * [open solaris on ec2](building.opensolaris.ec2.md)

