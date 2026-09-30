pipeline {
    agent any

    options {
        timestamps()
        timeout(time: 15, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    environment {
        IMAGE = 'study-cards'
        TAG   = "${env.BUILD_NUMBER}"
    }

    stages {
        stage('Validate') {
            steps {
                sh 'python3 scripts/validate_deck.py data/*.txt'
                sh 'node --check js/app.js'
                sh 'node --check js/scheduler.js'
                sh 'node scripts/test_scheduler.js'
            }
        }
        stage('Build & Smoke Test') {
            steps {
                sh 'bash scripts/smoke_test.sh ${IMAGE}:${TAG}'
            }
        }
        stage('Tag latest') {
            when { branch 'main' }
            steps {
                sh 'docker tag ${IMAGE}:${TAG} ${IMAGE}:latest'
            }
        }
    }

    post {
        always {
            sh 'docker rm -f $(docker ps -aq --filter name=study-cards-smoke) 2>/dev/null || true'
        }
    }
}
