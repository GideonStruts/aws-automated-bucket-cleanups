# Build a zip you can upload to the Lambda function.
#
#   make          install deps, bundle dist/, write the zip
#   make zip      same as make
#   make clean    remove dist/ and the zip
#
# The archive root contains index.js and package.json. In the Lambda
# console (or update-function-code), set the handler to index.handler.
# Runtime is nodejs24.x and the architecture is arm64, matching template.yaml.
# esbuild bundles dependencies, so node_modules is not in the zip.

ZIP := automated-bucket-cleanups.zip

.PHONY: all install build zip clean
.DELETE_ON_ERROR:

all: zip

node_modules: package.json package-lock.json
	npm ci
	@touch $@

build: node_modules
	npm run build

$(ZIP): build
	rm -f $@
	cd dist && zip -X -r ../$@ index.js package.json
	@echo "Wrote $@ (handler: index.handler)"

zip: $(ZIP)

clean:
	rm -rf dist $(ZIP)
