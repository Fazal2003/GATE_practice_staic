FROM nginx:alpine

WORKDIR /GATE_prep

COPY ~/projects/website/gate_practice/study-cards/index.html

RUN ["firefox","index.html"]
